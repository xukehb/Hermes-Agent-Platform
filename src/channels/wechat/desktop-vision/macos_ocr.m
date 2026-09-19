#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        if (argc < 2) {
            printf("[]\n");
            return 0;
        }

        // 模式 1：查找微信客户端的主窗口 ID 或 Bounds 详细坐标
        if (strcmp(argv[1], "--wechat-wid") == 0 || strcmp(argv[1], "--wechat-bounds") == 0) {
            CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
            for (int i = 0; i < CFArrayGetCount(list); i++) {
                NSDictionary *dict = (__bridge NSDictionary *)CFArrayGetValueAtIndex(list, i);
                NSString *owner = dict[(id)kCGWindowOwnerName];
                if ([owner containsString:@"WeChat"] || [owner containsString:@"微信"]) {
                    NSNumber *wid = dict[(id)kCGWindowNumber];
                    NSDictionary *bounds = dict[(id)kCGWindowBounds];
                    CGFloat width = [bounds[@"Width"] doubleValue];
                    CGFloat height = [bounds[@"Height"] doubleValue];
                    // 过滤托盘微图标或微小弹窗，锁定主聊天视窗
                    if (width > 300 && height > 300) {
                        if (strcmp(argv[1], "--wechat-wid") == 0) {
                            printf("%d\n", [wid intValue]);
                        } else {
                            CGFloat x = [bounds[@"X"] doubleValue];
                            CGFloat y = [bounds[@"Y"] doubleValue];
                            printf("{\"wid\":%d,\"x\":%.1f,\"y\":%.1f,\"width\":%.1f,\"height\":%.1f}\n", [wid intValue], x, y, width, height);
                        }
                        return 0;
                    }
                }
            }
            if (strcmp(argv[1], "--wechat-wid") == 0) {
                printf("0\n");
            } else {
                printf("{}\n");
            }
            return 1;
        }

        // 模式 3：模拟鼠标移动与点击 (SightFlow 纯视觉点击模式)
        if (strcmp(argv[1], "--click") == 0 && argc >= 4) {
            CGFloat x = atof(argv[2]);
            CGFloat y = atof(argv[3]);
            CGPoint pt = CGPointMake(x, y);

            CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, pt, kCGMouseButtonLeft);
            CGEventPost(kCGHIDEventTap, move);
            CFRelease(move);
            usleep(25000);

            CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, pt, kCGMouseButtonLeft);
            CGEventPost(kCGHIDEventTap, down);
            CFRelease(down);
            usleep(50000);

            CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, pt, kCGMouseButtonLeft);
            CGEventPost(kCGHIDEventTap, up);
            CFRelease(up);
            printf("{\"ok\":true,\"clicked\":[%.1f,%.1f]}\n", x, y);
            return 0;
        }

        if (strcmp(argv[1], "--double-click") == 0 && argc >= 4) {
            CGFloat x = atof(argv[2]);
            CGFloat y = atof(argv[3]);
            CGPoint pt = CGPointMake(x, y);

            CGEventRef down1 = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, pt, kCGMouseButtonLeft);
            CGEventSetIntegerValueField(down1, kCGMouseEventClickState, 1);
            CGEventPost(kCGHIDEventTap, down1);
            CFRelease(down1);
            usleep(30000);

            CGEventRef up1 = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, pt, kCGMouseButtonLeft);
            CGEventSetIntegerValueField(up1, kCGMouseEventClickState, 1);
            CGEventPost(kCGHIDEventTap, up1);
            CFRelease(up1);
            usleep(50000);

            CGEventRef down2 = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, pt, kCGMouseButtonLeft);
            CGEventSetIntegerValueField(down2, kCGMouseEventClickState, 2);
            CGEventPost(kCGHIDEventTap, down2);
            CFRelease(down2);
            usleep(30000);

            CGEventRef up2 = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, pt, kCGMouseButtonLeft);
            CGEventSetIntegerValueField(up2, kCGMouseEventClickState, 2);
            CGEventPost(kCGHIDEventTap, up2);
            CFRelease(up2);
            printf("{\"ok\":true,\"doubleClicked\":[%.1f,%.1f]}\n", x, y);
            return 0;
        }

        // 模式 2：对指定图像路径执行高精度本地原生 OCR
        NSString *path = [NSString stringWithUTF8String:argv[1]];
        NSURL *url = [NSURL fileURLWithPath:path];
        CGImageSourceRef src = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
        if (!src) {
            printf("[]\n");
            return 0;
        }
        CGImageRef cgImg = CGImageSourceCreateImageAtIndex(src, 0, NULL);
        CFRelease(src);
        if (!cgImg) {
            printf("[]\n");
            return 0;
        }

        NSMutableArray *items = [NSMutableArray array];
        VNRecognizeTextRequest *req = [[VNRecognizeTextRequest alloc] initWithCompletionHandler:^(VNRequest *r, NSError *err) {
            for (VNRecognizedTextObservation *obs in r.results) {
                VNRecognizedText *top = [[obs topCandidates:1] firstObject];
                if (top) {
                    CGRect box = obs.boundingBox;
                    [items addObject:[NSMutableDictionary dictionaryWithDictionary:@{
                        @"text": top.string ?: @"",
                        @"x": @(box.origin.x),
                        @"y": @(box.origin.y),
                        @"width": @(box.size.width),
                        @"height": @(box.size.height),
                        @"isTitle": @(NO)
                    }]];
                }
            }
        }];
        req.recognitionLanguages = @[@"zh-Hans", @"en-US"];
        req.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        req.usesLanguageCorrection = YES;

        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:cgImg options:@{}];
        NSError *err = nil;
        [handler performRequests:@[req] error:&err];

        // 阶段 2：专精顶部会话标题栏局部高精度增强扫描 (精准提取类似 "十一", "张三" 等短小字符)
        size_t imgW = CGImageGetWidth(cgImg);
        size_t imgH = CGImageGetHeight(cgImg);
        if (imgW > 200 && imgH > 150) {
            CGRect titleRect = CGRectMake(imgW * 0.34, 15, imgW * 0.35, 55);
            CGImageRef titleImg = CGImageCreateWithImageInRect(cgImg, titleRect);
            if (titleImg) {
                VNRecognizeTextRequest *titleReq = [[VNRecognizeTextRequest alloc] initWithCompletionHandler:^(VNRequest *tr, NSError *terr) {
                    for (VNRecognizedTextObservation *obs in tr.results) {
                        VNRecognizedText *top = [[obs topCandidates:1] firstObject];
                        if (top && top.string.length > 0) {
                            NSString *cleaned = [top.string stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
                            if (cleaned.length > 0 && ![cleaned containsString:@"搜索"]) {
                                [items addObject:@{
                                    @"text": cleaned,
                                    @"x": @(0.38),
                                    @"y": @(0.92),
                                    @"width": @(0.2),
                                    @"height": @(0.04),
                                    @"isTitle": @(YES)
                                }];
                            }
                        }
                    }
                }];
                titleReq.recognitionLanguages = @[@"zh-Hans", @"en-US"];
                titleReq.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
                VNImageRequestHandler *titleHandler = [[VNImageRequestHandler alloc] initWithCGImage:titleImg options:@{}];
                [titleHandler performRequests:@[titleReq] error:nil];
                CGImageRelease(titleImg);
            }
        }

        CGImageRelease(cgImg);

        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:items options:0 error:nil];
        if (jsonData) {
            NSString *jsonStr = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
            printf("%s\n", [jsonStr UTF8String]);
        } else {
            printf("[]\n");
        }
    }
    return 0;
}
