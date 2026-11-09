// Retired AV-only experiment. All environment screenshots must use the shared
// DesktopNative displayCapture entry point, which enforces CGDisplayStream.
import Foundation
fputs("This legacy display-pixel helper is disabled. Use DesktopNative.displayCapture (CGDisplayStream).\n", stderr)
exit(1)
