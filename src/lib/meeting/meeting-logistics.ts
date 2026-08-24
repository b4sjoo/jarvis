export function isExplicitMeetingLogisticsTranscript(text: string) {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.()]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  return /\b(one second|just a second|hold on|wait a second|take a look|share my screen|sharing my screen|start our interview|start the interview|let s start|let us start|let me search|let me think|let me check)\b/i.test(
    normalized
  ) || /等一下|稍等|我看一下|我想一下|我分享屏幕|开始面试|开始吧/.test(
    normalized
  );
}
