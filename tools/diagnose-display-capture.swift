// Read-only, full-display capture investigation. No app window handles, accessibility trees, or input events are used.
// Build: swiftc -O -parse-as-library -target arm64-apple-macos13.0 tools/diagnose-display-capture.swift -o /tmp/display-capture-probe -framework AppKit -framework ScreenCaptureKit -framework AVFoundation -framework IOSurface -framework CoreImage -framework CoreVideo
// Run: /tmp/display-capture-probe cg|av|sck /path/to/private/output-directory
// CGDisplayStream is deprecated/obsoleted in newer SDKs; runtime availability
// must be verified on each supported OS. This is a diagnostic, not a release backend.
import AppKit
import ScreenCaptureKit
import AVFoundation
import CoreImage
import IOSurface
import CoreVideo

let root=URL(fileURLWithPath:CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : NSTemporaryDirectory()+"workbunny-display-capture-probe")
final class Frames:NSObject,SCStreamOutput,AVCaptureVideoDataOutputSampleBufferDelegate,@unchecked Sendable {
 let lock=NSLock();var image:CGImage?;var count=0;var lastAt=Date.distantPast
 func set(_ im:CGImage?){guard let im else{return};lock.lock();image=im;count+=1;lastAt=Date();lock.unlock()}
 func pixel(_ p:CVPixelBuffer){let im=CIImage(cvPixelBuffer:p);set(CIContext().createCGImage(im,from:im.extent))}
 func stream(_ stream:SCStream,didOutputSampleBuffer b:CMSampleBuffer,of type:SCStreamOutputType){
  guard type == .screen,let p=b.imageBuffer,
   let a=CMSampleBufferGetSampleAttachmentsArray(b,createIfNecessary:false) as? [[SCStreamFrameInfo:Any]],
   let s=a.first?[.status] as? Int,s == SCFrameStatus.complete.rawValue else{return};pixel(p)
 }
 func captureOutput(_ output:AVCaptureOutput,didOutput b:CMSampleBuffer,from connection:AVCaptureConnection){if let p=b.imageBuffer{pixel(p)}}
 func save(_ name:String)->Bool {
  lock.lock();let im=image,n=count,age=Date().timeIntervalSince(lastAt);lock.unlock()
  guard let im,let data=NSBitmapImageRep(cgImage:im).representation(using:.png,properties:[:]) else{print("\(name): no frame");return false}
  do{let url=root.appendingPathComponent(name+".png");try data.write(to:url);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path);print("\(name): frames=\(n) size=\(im.width)x\(im.height) ageMs=\(Int(age*1000))");return true}catch{print("\(name): \(error)");return false}
 }
}
@main struct Probe {
 static func main() async {
  let mode=CommandLine.arguments.dropFirst().first ?? "sck"
  do {
   guard ["av","cg","sck"].contains(mode) else { print("usage: display-capture-probe cg|av|sck output-directory"); return }
   guard CGPreflightScreenCaptureAccess() else { print("screen recording permission is required"); return }
   let session=CGSessionCopyCurrentDictionary() as? [String:Any]
   guard session?["CGSSessionScreenIsLocked"] as? Bool != true else { print("screen is locked"); return }
   try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
   if mode == "av" {
    let session=AVCaptureSession();guard let input=AVCaptureScreenInput(displayID:CGMainDisplayID()) else{print("av: input unavailable");return}
    input.capturesCursor=false;input.minFrameDuration=CMTime(value:1,timescale:5)
    let output=AVCaptureVideoDataOutput(),frames=Frames();output.setSampleBufferDelegate(frames,queue:DispatchQueue(label:"probe.av"))
    guard session.canAddInput(input),session.canAddOutput(output) else{print("av: setup unavailable");return}
    session.addInput(input);session.addOutput(output);session.startRunning()
    try await Task.sleep(for:.seconds(2));_ = frames.save("av-screen-input");session.stopRunning();return
   }
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
   let content=try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:true)
   guard let d=content.displays.first(where:{$0.displayID==CGMainDisplayID()}) else{print("no display");return}
   let wx=content.applications.filter{$0.bundleIdentifier=="com.tencent.xinWeChat"}
   let bunny=content.applications.filter{$0.bundleIdentifier=="cn.haminn.workbunny"}
   for name in ["exclude-wechat-to-full","exclude-bunny-to-full","full-exclude-wechat-full","full-ignore-clip"] {
    let frames=Frames(),config=SCStreamConfiguration();config.width=d.width;config.height=d.height;config.showsCursor=false;config.minimumFrameInterval=CMTime(value:1,timescale:5)
    if #available(macOS 14.0,*),name == "full-ignore-clip"{config.ignoreGlobalClipDisplay=true}
    let initial:SCContentFilter
    if name == "exclude-wechat-to-full"{initial=SCContentFilter(display:d,excludingApplications:wx,exceptingWindows:[])}
    else if name == "exclude-bunny-to-full"{initial=SCContentFilter(display:d,excludingApplications:bunny,exceptingWindows:[])}
    else{initial=SCContentFilter(display:d,excludingApplications:[],exceptingWindows:[])}
    let stream=SCStream(filter:initial,configuration:config,delegate:nil)
    try stream.addStreamOutput(frames,type:.screen,sampleHandlerQueue:DispatchQueue(label:"probe."+name))
    try await stream.startCapture();try await Task.sleep(for:.milliseconds(600))
    if name == "full-exclude-wechat-full"{try await stream.updateContentFilter(SCContentFilter(display:d,excludingApplications:wx,exceptingWindows:[]));try await Task.sleep(for:.milliseconds(400))}
    try await stream.updateContentFilter(SCContentFilter(display:d,excludingApplications:[],exceptingWindows:[]))
    try await Task.sleep(for:.milliseconds(1200));_ = frames.save(name);try await stream.stopCapture()
   }
  }catch{print("probe error: \(error)")}
 }
}
