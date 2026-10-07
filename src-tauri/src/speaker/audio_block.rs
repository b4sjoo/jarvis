use futures_util::{Stream, StreamExt};
use ringbuf::{
    traits::{Consumer, Observer, Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use std::pin::Pin;
use std::task::{Context, Poll};

#[derive(Debug, Clone, Copy)]
pub(crate) struct SourceAudioTime {
    pub sample_time: f64,
    pub host_time_ns: u64,
    pub captured_at_ms: u64,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct AudioBlockMetadata {
    pub sample_rate: u32,
    pub frames: usize,
    pub source_time: Option<SourceAudioTime>,
}

#[derive(Debug)]
pub struct AudioBlock {
    pub(crate) metadata: AudioBlockMetadata,
    pub(crate) samples: Vec<f32>,
}

// The descriptor is published last. A reader never sees samples without their clock.
pub(crate) struct AudioBlockProducer {
    samples: HeapProd<f32>,
    metadata: HeapProd<AudioBlockMetadata>,
}

pub(crate) struct AudioBlockConsumer {
    samples: HeapCons<f32>,
    metadata: HeapCons<AudioBlockMetadata>,
}

pub(crate) fn audio_block_queue(
    samples: usize,
    blocks: usize,
) -> (AudioBlockProducer, AudioBlockConsumer) {
    let (sample_tx, sample_rx) = HeapRb::new(samples).split();
    let (meta_tx, meta_rx) = HeapRb::new(blocks).split();
    (
        AudioBlockProducer {
            samples: sample_tx,
            metadata: meta_tx,
        },
        AudioBlockConsumer {
            samples: sample_rx,
            metadata: meta_rx,
        },
    )
}

impl AudioBlockProducer {
    pub fn push(&mut self, samples: &[f32], metadata: AudioBlockMetadata) -> bool {
        if samples.is_empty()
            || metadata.frames != samples.len()
            || self.samples.vacant_len() < samples.len()
            || self.metadata.is_full()
        {
            return false;
        }
        let written = self.samples.push_slice(samples);
        debug_assert_eq!(written, samples.len());
        let published = self.metadata.try_push(metadata).is_ok();
        debug_assert!(published);
        published
    }
}

impl AudioBlockConsumer {
    pub fn pop(&mut self) -> Option<AudioBlock> {
        let metadata = self.metadata.try_pop()?;
        let mut samples = vec![0.0; metadata.frames];
        let read = self.samples.pop_slice(&mut samples);
        debug_assert_eq!(read, metadata.frames);
        samples.truncate(read);
        Some(AudioBlock { metadata, samples })
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct AudioSpan {
    pub sample_rate: u32,
    pub sample_start: u64,
    pub captured_at_ms: u64,
    pub native_clock: bool,
    pub reason: &'static str,
    pub gap_ms: Option<f64>,
}

impl AudioSpan {
    pub fn wall_ms(&self, sample: u64) -> u64 {
        self.captured_at_ms.saturating_add(
            sample
                .saturating_sub(self.sample_start)
                .saturating_mul(1000)
                / u64::from(self.sample_rate),
        )
    }
}

#[derive(Default)]
struct BlockClock {
    previous: Option<AudioBlockMetadata>,
}

impl BlockClock {
    fn observe(
        &mut self,
        block: &AudioBlock,
    ) -> Result<(Option<&'static str>, Option<f64>), &'static str> {
        let metadata = block.metadata;
        if !(8_000..=96_000).contains(&metadata.sample_rate)
            || metadata.frames == 0
            || metadata.frames != block.samples.len()
        {
            return Err("invalid-audio-block");
        }
        if let Some(time) = metadata.source_time {
            if !time.sample_time.is_finite() || time.host_time_ns == 0 {
                return Err("invalid-audio-clock");
            }
        }
        let mut reason = None;
        let mut gap_ms = None;
        if let Some(previous) = self.previous {
            if metadata.sample_rate != previous.sample_rate {
                reason = Some("sample-rate-changed");
            }
            match (previous.source_time, metadata.source_time) {
                (Some(old), Some(new)) => {
                    if new.host_time_ns <= old.host_time_ns {
                        return Err("non-monotonic-audio-clock");
                    }
                    let elapsed = (new.host_time_ns - old.host_time_ns) as f64 / 1e9;
                    let expected = previous.frames as f64 / previous.sample_rate as f64;
                    gap_ms = Some((elapsed - expected) * 1000.0);
                    let sample_delta = new.sample_time - old.sample_time;
                    if (sample_delta - previous.frames as f64).abs() > 1.0 {
                        reason = reason.or(Some("source-clock-discontinuity"));
                    }
                    // Allow one source-frame of clock quantization, not a guessed rate fallback.
                    if reason.is_none()
                        && (elapsed * metadata.sample_rate as f64 - sample_delta).abs() > 1.0
                    {
                        return Err("audio-rate-clock-mismatch");
                    }
                }
                (None, None) => {}
                _ => return Err("audio-clock-provenance-changed"),
            }
        } else {
            reason = Some("first-audio-block");
        }
        self.previous = Some(metadata);
        Ok((reason, gap_ms))
    }
}

// Exposes one homogeneous span at a time to the existing sample-based VAD.
// The first block after a boundary stays pending until the old span is flushed.
pub(crate) struct AudioSpanStream<S> {
    pub inner: S,
    block: Option<AudioBlock>,
    offset: usize,
    clock: BlockClock,
    span: Option<AudioSpan>,
    next_reason: Option<&'static str>,
    next_gap_ms: Option<f64>,
    pub sample_position: u64,
    pub at_boundary: bool,
    pub error: Option<&'static str>,
    fallback_start_ms: u64,
    ended: bool,
}

impl<S: Stream<Item = AudioBlock> + Unpin> AudioSpanStream<S> {
    pub fn new(inner: S, fallback_start_ms: u64) -> Self {
        Self {
            inner,
            block: None,
            offset: 0,
            clock: BlockClock::default(),
            span: None,
            next_reason: None,
            next_gap_ms: None,
            sample_position: 0,
            at_boundary: false,
            error: None,
            fallback_start_ms,
            ended: false,
        }
    }

    fn accept(&mut self, block: AudioBlock) -> bool {
        match self.clock.observe(&block) {
            Ok((reason, gap)) => {
                self.next_reason = reason;
                self.next_gap_ms = gap;
                self.offset = 0;
                self.block = Some(block);
                true
            }
            Err(error) => {
                self.error = Some(error);
                self.ended = true;
                false
            }
        }
    }

    pub async fn begin_span(&mut self) -> Option<AudioSpan> {
        if self.ended {
            return None;
        }
        if self.block.is_none() {
            let block = self.inner.next().await?;
            if !self.accept(block) {
                return None;
            }
        }
        let metadata = self.block.as_ref()?.metadata;
        let captured_at_ms = metadata
            .source_time
            .map(|t| t.captured_at_ms)
            .unwrap_or_else(|| {
                self.span
                    .map(|s| s.wall_ms(self.sample_position))
                    .unwrap_or(self.fallback_start_ms)
            });
        let span = AudioSpan {
            sample_rate: metadata.sample_rate,
            sample_start: self.sample_position,
            captured_at_ms,
            native_clock: metadata.source_time.is_some(),
            reason: self.next_reason.take().unwrap_or("first-audio-block"),
            gap_ms: self.next_gap_ms.take(),
        };
        self.span = Some(span);
        self.at_boundary = false;
        Some(span)
    }

    pub fn buffered_sample(&mut self) -> Option<f32> {
        if self.at_boundary || self.ended {
            return None;
        }
        let sample = *self.block.as_ref()?.samples.get(self.offset)?;
        self.offset += 1;
        self.sample_position += 1;
        Some(sample)
    }
}

impl<S: Stream<Item = AudioBlock> + Unpin> Stream for AudioSpanStream<S> {
    type Item = f32;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<f32>> {
        let this = self.get_mut();
        if this.at_boundary || this.ended {
            return Poll::Ready(None);
        }
        loop {
            if let Some(sample) = this.buffered_sample() {
                return Poll::Ready(Some(sample));
            }
            this.block = None;
            match Pin::new(&mut this.inner).poll_next(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(None) => {
                    this.ended = true;
                    return Poll::Ready(None);
                }
                Poll::Ready(Some(block)) => {
                    if !this.accept(block) {
                        return Poll::Ready(None);
                    }
                    if this.next_reason.is_some() {
                        this.at_boundary = true;
                        return Poll::Ready(None);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;

    fn block(rate: u32, sample_time: f64, host_ns: u64, value: f32) -> AudioBlock {
        AudioBlock {
            metadata: AudioBlockMetadata {
                sample_rate: rate,
                frames: 480,
                source_time: Some(SourceAudioTime {
                    sample_time,
                    host_time_ns: host_ns,
                    captured_at_ms: host_ns / 1_000_000,
                }),
            },
            samples: vec![value; 480],
        }
    }

    #[tokio::test]
    async fn queued_old_blocks_keep_their_rate_and_new_blocks_survive_boundary_flush() {
        let blocks = vec![
            block(48000, 0., 1_000_000_000, 1.),
            block(48000, 480., 1_010_000_000, 2.),
            block(24000, 0., 1_030_000_000, 3.),
            block(24000, 480., 1_050_000_000, 4.),
            block(48000, 0., 1_100_000_000, 5.),
        ];
        let mut source = AudioSpanStream::new(stream::iter(blocks), 0);
        let first = source.begin_span().await.unwrap();
        assert_eq!(first.sample_rate, 48000);
        let a: Vec<_> = source.by_ref().collect().await;
        assert_eq!(a.len(), 960);
        assert_eq!(a[479], 1.);
        assert_eq!(a[480], 2.);
        let second = source.begin_span().await.unwrap();
        assert_eq!(
            (
                second.sample_rate,
                second.sample_start,
                second.captured_at_ms
            ),
            (24000, 960, 1030)
        );
        assert_eq!(second.wall_ms(1440), 1050);
        let b: Vec<_> = source.by_ref().collect().await;
        assert_eq!(b.len(), 960);
        assert_eq!(b[0], 3.);
        let third = source.begin_span().await.unwrap();
        assert_eq!(third.sample_start, 1920);
        let c: Vec<_> = source.by_ref().collect().await;
        assert_eq!(c, vec![5.; 480]);
        assert!(source.begin_span().await.is_none());
        assert!(source.error.is_none());
    }

    #[tokio::test]
    async fn first_block_not_startup_hint_owns_24k_and_clock_reset_is_a_boundary() {
        let mut s = AudioSpanStream::new(
            stream::iter(vec![
                block(24000, 0., 1_000_000_000, 1.),
                block(24000, 0., 1_100_000_000, 2.),
            ]),
            0,
        );
        let a = s.begin_span().await.unwrap();
        assert_eq!(a.sample_rate, 24000);
        assert_eq!(s.by_ref().collect::<Vec<_>>().await.len(), 480);
        let b = s.begin_span().await.unwrap();
        assert_eq!(b.reason, "source-clock-discontinuity");
        assert!((b.gap_ms.unwrap() - 80.).abs() < 0.001);
    }

    #[tokio::test]
    async fn invalid_or_contradictory_clock_never_delivers_bad_samples() {
        for bad in [
            block(0, 0., 1_010_000_000, 2.),
            block(48000, 480., 1_020_000_000, 2.),
            block(48000, 480., 900_000_000, 2.),
        ] {
            let mut s = AudioSpanStream::new(
                stream::iter(vec![block(48000, 0., 1_000_000_000, 1.), bad]),
                0,
            );
            s.begin_span().await.unwrap();
            assert_eq!(s.by_ref().collect::<Vec<_>>().await, vec![1.; 480]);
            assert!(s.error.is_some());
            assert!(s.begin_span().await.is_none());
        }
    }

    #[test]
    fn queue_publishes_whole_blocks_or_nothing() {
        let (mut tx, mut rx) = audio_block_queue(6, 2);
        let meta = AudioBlockMetadata {
            sample_rate: 24000,
            frames: 4,
            source_time: None,
        };
        assert!(tx.push(&[1.; 4], meta));
        assert!(!tx.push(&[2.; 4], meta));
        assert_eq!(rx.pop().unwrap().samples, vec![1.; 4]);
        assert!(rx.pop().is_none());
        assert!(tx.push(&[3.; 4], meta));
        assert_eq!(rx.pop().unwrap().metadata.sample_rate, 24000);
    }

    #[tokio::test]
    async fn stop_at_a_pending_boundary_does_not_consume_the_new_span() {
        let mut s = AudioSpanStream::new(
            stream::iter(vec![
                block(48000, 0., 1_000_000_000, 1.),
                block(24000, 0., 1_020_000_000, 2.),
            ]),
            0,
        );
        s.begin_span().await.unwrap();
        assert_eq!(s.by_ref().collect::<Vec<_>>().await.len(), 480);
        assert!(s.at_boundary);
        assert_eq!(s.sample_position, 480);
        assert!(s.buffered_sample().is_none());
        assert!(s.next().await.is_none());
        assert_eq!(s.sample_position, 480);
    }
}
