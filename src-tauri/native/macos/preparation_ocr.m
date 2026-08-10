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

static CGImageRef jarvis_copy_srgb_image(CGImageRef source) {
  if (source == NULL) {
    return NULL;
  }
  size_t source_width = CGImageGetWidth(source);
  size_t source_height = CGImageGetHeight(source);
  if (source_width == 0 || source_height == 0) {
    return NULL;
  }
  size_t width = ((source_width + 15) / 16) * 16;
  size_t height = ((source_height + 15) / 16) * 16;

  CGColorSpaceRef color_space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  if (color_space == NULL) {
    return NULL;
  }
  CGContextRef context = CGBitmapContextCreate(
      NULL, width, height, 8, width * 4, color_space,
      kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGColorSpaceRelease(color_space);
  if (context == NULL) {
    return NULL;
  }
  CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
  CGContextDrawImage(context, CGRectMake(0, 0, width, height), source);
  CGImageRef normalized = CGBitmapContextCreateImage(context);
  CGContextRelease(context);
  return normalized;
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
      CGFloat rendered_width = MAX(16, floor(NSWidth(bounds) * scale));
      CGFloat rendered_height = MAX(16, floor(NSHeight(bounds) * scale));
      rendered_width = MAX(16, floor(rendered_width / 16.0) * 16.0);
      rendered_height = MAX(16, floor(rendered_height / 16.0) * 16.0);
      NSSize render_size = NSMakeSize(rendered_width, rendered_height);
      NSImage *thumbnail = [page thumbnailOfSize:render_size
                                          forBox:kPDFDisplayBoxMediaBox];
      NSData *tiff_data = thumbnail.TIFFRepresentation;
      NSBitmapImageRep *bitmap =
          tiff_data == nil ? nil : [NSBitmapImageRep imageRepWithData:tiff_data];
      if (bitmap == nil || bitmap.CGImage == NULL) {
        return jarvis_ocr_error(@"PDFKit could not render the page.");
      }
      CGImageRef cg_image = jarvis_copy_srgb_image(bitmap.CGImage);
      if (cg_image == NULL) {
        return jarvis_ocr_error(@"PDFKit could not create an sRGB page image.");
      }

      NSBitmapImageRep *vision_bitmap =
          [[NSBitmapImageRep alloc] initWithCGImage:cg_image];
      NSData *vision_png = [vision_bitmap
          representationUsingType:NSBitmapImageFileTypePNG
                        properties:@{}];
      CGImageRelease(cg_image);
      if (vision_png == nil) {
        return jarvis_ocr_error(@"PDFKit could not encode the OCR page image.");
      }

      if (@available(macOS 10.15, *)) {
      VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
      request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
      request.usesLanguageCorrection = YES;
      if (@available(macOS 13.0, *)) {
        request.automaticallyDetectsLanguage = YES;
      } else {
        request.recognitionLanguages = @[ @"en-US" ];
      }

      VNImageRequestHandler *handler =
          [[VNImageRequestHandler alloc] initWithData:vision_png options:@{}];
      NSError *request_error = nil;
      if (![handler performRequests:@[ request ] error:&request_error]) {
        NSString *message = @"Vision OCR failed.";
        if (request_error != nil) {
          message = [NSString stringWithFormat:@"Vision OCR failed (%@/%ld): %@",
                                               request_error.domain,
                                               (long)request_error.code,
                                               request_error.description];
        }
        return jarvis_ocr_error(message);
      }

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
      } else {
        return jarvis_ocr_error(@"Local PDF OCR requires macOS 10.15 or newer.");
      }
    } @catch (NSException *exception) {
      return jarvis_ocr_error(exception.reason ?: @"Native OCR raised an exception.");
    }
  }
}

char *jarvis_render_pdf_page(const char *pdf_path, size_t page_index,
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
      NSSize render_size = NSMakeSize(
          MAX(16, floor(NSWidth(bounds) * scale)),
          MAX(16, floor(NSHeight(bounds) * scale)));
      NSImage *thumbnail = [page thumbnailOfSize:render_size
                                          forBox:kPDFDisplayBoxMediaBox];
      NSData *tiff_data = thumbnail.TIFFRepresentation;
      NSBitmapImageRep *bitmap =
          tiff_data == nil ? nil : [NSBitmapImageRep imageRepWithData:tiff_data];
      NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG
                                         properties:@{}];
      if (png == nil) {
        return jarvis_ocr_error(@"PDFKit could not encode the rendered page.");
      }
      return jarvis_copy_json(@{
        @"success": @YES,
        @"base64": [png base64EncodedStringWithOptions:0],
        @"mediaType": @"image/png",
        @"pageNumber": @(page_index + 1),
        @"pageCount": @(document.pageCount),
        @"lines": @[]
      });
    } @catch (NSException *exception) {
      return jarvis_ocr_error(exception.reason ?: @"Native PDF rendering raised an exception.");
    }
  }
}

void jarvis_free_ocr_result(char *value) {
  free(value);
}
