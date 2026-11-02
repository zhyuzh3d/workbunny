// Display-only helper: no application lookup, window IDs, AX, AppleScript,
// plugins, message stores, process attachment or application-specific calls.
import Foundation
import CoreGraphics
import AVFoundation
import CoreImage
import ImageIO
import Vision
import CryptoKit

struct PixelError: Error { let message: String }
final class Pixels: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    let lock = NSLock(), context = CIContext()
    var latest: CGImage?, at = Date.distantPast, sequence = 0
    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let buffer = sample.imageBuffer else { return }
        let ci = CIImage(cvPixelBuffer: buffer)
        guard let image = context.createCGImage(ci, from: ci.extent) else { return }
        lock.lock(); latest = image; at = Date(); sequence += 1; lock.unlock()
    }
    func frame() throws -> (CGImage, Date, Int) {
        lock.lock(); defer { lock.unlock() }
        guard let image = latest, Date().timeIntervalSince(at) < 1.5 else { throw PixelError(message: "No fresh full-display frame") }
        return (image, at, sequence)
    }
}
func png(_ image: CGImage) throws -> Data {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { throw PixelError(message: "PNG encoder unavailable") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw PixelError(message: "PNG encoding failed") }
    return data as Data
}
func rect(_ value: Any?) throws -> CGRect {
    guard let r = value as? [String: Double], let x = r["x"], let y = r["y"], let w = r["width"], let h = r["height"],
        [x,y,w,h].allSatisfy({ $0.isFinite }), w > 0, h > 0 else { throw PixelError(message: "Invalid pixel region") }
    return CGRect(x: x, y: y, width: w, height: h)
}
func digest(_ image: CGImage, _ region: CGRect) throws -> String {
    guard CGRect(x:0,y:0,width:image.width,height:image.height).contains(region), let crop = image.cropping(to: region) else { throw PixelError(message: "Region left full display") }
    return SHA256.hash(data: try png(crop)).map { String(format:"%02x", $0) }.joined()
}
func run(_ request: [String: Any], pixels: Pixels, display: CGDirectDisplayID) throws -> [String: Any] {
    let screen = CGDisplayBounds(display)
    switch request["op"] as? String ?? "" {
    case "capture":
        let (image, at, sequence) = try pixels.frame()
        return ["backend":"AVCaptureScreenInput/persistent", "capturedAt":at.timeIntervalSince1970*1000, "sequence":sequence,
            "width":image.width,"height":image.height,"desktopRect":["x":screen.minX,"y":screen.minY,"width":screen.width,"height":screen.height],
            "pngBase64":try png(image).base64EncodedString()]
    case "recognize":
        guard let s = request["pngBase64"] as? String, let data = Data(base64Encoded:s), data.count <= 8*1024*1024,
            let source = CGImageSourceCreateWithData(data as CFData,nil), let image = CGImageSourceCreateImageAtIndex(source,0,nil) else { throw PixelError(message:"Invalid OCR image") }
        var rows: [[String:Any]] = []
        for languages in [["zh-Hans","en-US"],["en-US"]] {
            let vision = VNRecognizeTextRequest(); vision.recognitionLevel = .accurate; vision.recognitionLanguages = languages; vision.usesLanguageCorrection = false
            try VNImageRequestHandler(cgImage:image,options:[:]).perform([vision])
            for row in vision.results ?? [] {
                guard let text = row.topCandidates(1).first else { continue }; let b = row.boundingBox
                rows.append(["text":text.string,"confidence":Double(text.confidence),"x":b.minX,"y":1-b.maxY,"width":b.width,"height":b.height])
            }
        }
        return ["texts":rows,"width":image.width,"height":image.height]
    case "inputIdle":
        return ["hidIdleMs":CGEventSource.secondsSinceLastEventType(.hidSystemState,eventType:CGEventType(rawValue:UInt32.max)!)*1000]
    // Input is deliberately absent in the first read-only capture trial.
    default: throw PixelError(message:"Operation denied by display-only allowlist")
    }
}
@main struct DisplayPixels {
    static func main() {
        guard CGPreflightScreenCaptureAccess() else { fputs("Screen recording permission required\n",stderr); return }
        let display = CGMainDisplayID(), session = AVCaptureSession(), pixels = Pixels()
        guard let input = AVCaptureScreenInput(displayID:display) else { return }
        input.capturesCursor = false; input.capturesMouseClicks = false
        input.minFrameDuration = CMTime(value:1,timescale:2); input.removesDuplicateFrames = false
        let output = AVCaptureVideoDataOutput(); output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(pixels,queue:DispatchQueue(label:"bunny.display-pixels.frames"))
        guard session.canAddInput(input), session.canAddOutput(output) else { return }
        session.addInput(input); session.addOutput(output)
        DispatchQueue.global(qos:.userInitiated).async {
            session.startRunning()
            while let line = readLine() {
                var result: [String:Any] = [:]
                do {
                    guard let data = line.data(using:.utf8), let request = try JSONSerialization.jsonObject(with:data) as? [String:Any] else { throw PixelError(message:"Invalid request") }
                    result["id"] = request["id"] ?? NSNull()
                    result["result"] = try run(request,pixels:pixels,display:display); result["ok"] = true
                } catch { result["ok"] = false; result["error"] = (error as? PixelError)?.message ?? String(describing:error) }
                if let data = try? JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]), let json = String(data:data,encoding:.utf8) { print(json); fflush(stdout) }
            }
            session.stopRunning(); exit(0)
        }
        dispatchMain()
    }
}
