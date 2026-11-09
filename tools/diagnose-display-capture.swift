// Read-only, full-display capture investigation. No app window handles, accessibility trees, or input events are used.
// Build: swiftc -O -parse-as-library -target arm64-apple-macos13.0 tools/diagnose-display-capture.swift -o /tmp/display-capture-probe -framework AppKit -framework IOSurface -framework CoreImage -framework CoreVideo
// Run: /tmp/display-capture-probe cg /path/to/private/output-directory
// CGDisplayStream is deprecated/obsoleted in newer SDKs; runtime availability
// must be verified on each supported OS. This is a diagnostic, not a release backend.
import AppKit
import CoreImage
import IOSurface
import CoreVideo

let root=URL(fileURLWithPath:CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : NSTemporaryDirectory()+"workbunny-display-capture-probe")
final class Frames:@unchecked Sendable {
 let lock=NSLock();var image:CGImage?;var count=0;var lastAt=Date.distantPast
 func set(_ im:CGImage?){guard let im else{return};lock.lock();image=im;count+=1;lastAt=Date();lock.unlock()}
 func save(_ name:String)->Bool {
  lock.lock();let im=image,n=count,age=Date().timeIntervalSince(lastAt);lock.unlock()
  guard let im,let data=NSBitmapImageRep(cgImage:im).representation(using:.png,properties:[:]) else{print("\(name): no frame");return false}
  do{let url=root.appendingPathComponent(name+".png");try data.write(to:url);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path);print("\(name): frames=\(n) size=\(im.width)x\(im.height) ageMs=\(Int(age*1000))");return true}catch{print("\(name): \(error)");return false}
 }
}
@main struct Probe {
 static func main() async {
  let mode=CommandLine.arguments.dropFirst().first ?? "cg"
  do {
   guard mode == "cg" else { print("Only CGDisplayStream capture is allowed; usage: display-capture-probe cg output-directory"); return }
   guard CGPreflightScreenCaptureAccess() else { print("screen recording permission is required"); return }
   let session=CGSessionCopyCurrentDictionary() as? [String:Any]
   guard session?["CGSSessionScreenIsLocked"] as? Bool != true else { print("screen is locked"); return }
   try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
   if mode == "cg" {
    let rect=CGDisplayBounds(CGMainDisplayID()),frames=Frames()
    let props=[CGDisplayStream.showCursor:false] as CFDictionary
    guard let stream=CGDisplayStream(dispatchQueueDisplay:CGMainDisplayID(),outputWidth:Int(rect.width),outputHeight:Int(rect.height),pixelFormat:Int32(kCVPixelFormatType_32BGRA),properties:props,queue:DispatchQueue(label:"probe.cg"),handler:{status,_,surface,_ in
     guard status == .frameComplete,let surface else{return}
     let im=CIImage(ioSurface:surface);frames.set(CIContext().createCGImage(im,from:im.extent))
    }) else{print("cg-display-stream: unavailable");return}
    let result=stream.start();print("cg-display-stream start=\(result.rawValue)")
    try await Task.sleep(for:.seconds(2));_ = frames.save("cg-display-stream");stream.stop();return
   }
  }catch{print("probe error: \(error)")}
 }
}
