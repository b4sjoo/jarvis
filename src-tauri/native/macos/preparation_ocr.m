#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <PDFKit/PDFKit.h>
#import <Vision/Vision.h>

static char *jarvis_copy_json(NSDictionary *payload) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
  if (data == nil) {
    NSString *message = error.localizedDescription ?: @"Failed to serialize OCR result.";
    data = [NSJSONSerialization dataWithJSONObject:@{
      @"success": @NO,
      @"error": message,
      @"lines": @[]
    } options:0 error:nil];
  }
  if (data == nil) {
    return NULL;
  }

  char *result = malloc(data.length + 1);
  if (result == NULL) {
    return NULL;
  }
  memcpy(result, data.bytes, data.length);
  result[data.length] = '\0';
  return result;
}

static char *jarvis_ocr_error(NSString *message) {
  return jarvis_copy_json(@{
    @"success": @NO,
    @"error": message ?: @"Unknown OCR error.",
    @"lines": @[]
  });
}

char *jarvis_ocr_pdf_page(const char *pdf_path, size_t page_index,
                          size_t max_dimension) {
  @autoreleasepool {
    @try {
      if (pdf_path == NULL) {
        return jarvis_ocr_error(@"PDF path is unavailable.");
      }
      NSString *path = [NSString stringWithUTF8String:pdf_path];
      if (path == nil) {
        return jarvis_ocr_error(@"PDF path is not valid UTF-8.");
      }

      PDFDocument *document = [[PDFDocument alloc]
          initWithURL:[NSURL fileURLWithPath:path isDirectory:NO]];
      if (document == nil) {
        return jarvis_ocr_error(@"PDFKit could not open the document.");
      }
      if (page_index >= (size_t)document.pageCount) {
        return jarvis_ocr_error(@"PDF page index is out of range.");
      }

      PDFPage *page = [document pageAtIndex:(NSInteger)page_index];
      if (page == nil) {
        return jarvis_ocr_error(@"PDFKit could not load the page.");
      }
      NSRect bounds = [page boundsForBox:kPDFDisplayBoxMediaBox];
      CGFloat longest_edge = MAX(NSWidth(bounds), NSHeight(bounds));
      if (longest_edge <= 0) {
        return jarvis_ocr_error(@"PDF page has invalid dimensions.");
      }

      CGFloat bounded_dimension = (CGFloat)MAX((size_t)512, max_dimension);
      CGFloat scale = bounded_dimension / longest_edge;
      NSSize render_size = NSMakeSize(MAX(1, floor(NSWidth(bounds) * scale)),
                                      MAX(1, floor(NSHeight(bounds) * scale)));
      NSImage *thumbnail = [page thumbnailOfSize:render_size
                                          forBox:kPDFDisplayBoxMediaBox];
      NSData *tiff_data = thumbnail.TIFFRepresentation;
      NSBitmapImageRep *bitmap =
          tiff_data == nil ? nil : [NSBitmapImageRep imageRepWithData:tiff_data];
      if (bitmap == nil || bitmap.CGImage == NULL) {
        return jarvis_ocr_error(@"PDFKit could not render the page.");
      }
      CGImageRef cg_image = CGImageCreateCopy(bitmap.CGImage);
      if (cg_image == NULL) {
        return jarvis_ocr_error(@"PDFKit could not create a rendered page image.");
      }

      VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
      request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
      request.usesLanguageCorrection = YES;
      if (@available(macOS 13.0, *)) {
        request.automaticallyDetectsLanguage = YES;
      }

      VNImageRequestHandler *handler =
          [[VNImageRequestHandler alloc] initWithCGImage:cg_image options:@{}];
      NSError *request_error = nil;
      if (![handler performRequests:@[ request ] error:&request_error]) {
        CGImageRelease(cg_image);
        return jarvis_ocr_error(request_error.localizedDescription ?: @"Vision OCR failed.");
      }
      CGImageRelease(cg_image);

      NSArray<VNRecognizedTextObservation *> *observations = request.results ?: @[];
      observations = [observations sortedArrayUsingComparator:^NSComparisonResult(
          VNRecognizedTextObservation *left,
          VNRecognizedTextObservation *right) {
        CGFloat vertical_delta = CGRectGetMaxY(left.boundingBox) -
                                 CGRectGetMaxY(right.boundingBox);
        if (fabs(vertical_delta) > 0.01) {
          return vertical_delta > 0 ? NSOrderedAscending : NSOrderedDescending;
        }
        CGFloat horizontal_delta = CGRectGetMinX(left.boundingBox) -
                                   CGRectGetMinX(right.boundingBox);
        if (fabs(horizontal_delta) < 0.001) {
          return NSOrderedSame;
        }
        return horizontal_delta < 0 ? NSOrderedAscending : NSOrderedDescending;
      }];

      NSMutableArray<NSDictionary *> *lines = [NSMutableArray array];
      NSMutableArray<NSString *> *text_lines = [NSMutableArray array];
      double confidence_total = 0;
      for (VNRecognizedTextObservation *observation in observations) {
        VNRecognizedText *candidate = [[observation topCandidates:1] firstObject];
        if (candidate == nil || candidate.string.length == 0) {
          continue;
        }
        [text_lines addObject:candidate.string];
        confidence_total += candidate.confidence;
        CGRect box = observation.boundingBox;
        [lines addObject:@{
          @"text": candidate.string,
          @"confidence": @(candidate.confidence),
          @"x": @(box.origin.x),
          @"y": @(box.origin.y),
          @"width": @(box.size.width),
          @"height": @(box.size.height)
        }];
      }

      double average_confidence =
          lines.count > 0 ? confidence_total / (double)lines.count : 0;
      return jarvis_copy_json(@{
        @"success": @YES,
        @"text": [text_lines componentsJoinedByString:@"\n"],
        @"averageConfidence": @(average_confidence),
        @"lines": lines
      });
    } @catch (NSException *exception) {
      return jarvis_ocr_error(exception.reason ?: @"Native OCR raised an exception.");
    }
  }
}

void jarvis_free_ocr_result(char *value) {
  free(value);
}
