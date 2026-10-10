// Lift the main subject out of a photograph, for art such as the diagram on the About page
// (app/web/public/art/). macOS only: it uses the system's own subject mask (Vision).
//
//   swift scripts/cutout.swift photo.jpg object.png [longest side in pixels, default 720]
//
// The result is cropped to the subject and has a transparent background.
import AppKit
import Vision
import CoreImage
let args = CommandLine.arguments
let input = URL(fileURLWithPath: args[1]), output = URL(fileURLWithPath: args[2])
let maxSide = args.count > 3 ? CGFloat(Double(args[3])!) : 720
guard let src = CIImage(contentsOf: input, options: [.applyOrientationProperty: true]) else { fatalError("cannot read \(args[1])") }
let handler = VNImageRequestHandler(ciImage: src)
let request = VNGenerateForegroundInstanceMaskRequest()
try handler.perform([request])
guard let result = request.results?.first else { fatalError("no subject found") }
// All instances by default; keep them all, the photo is of one thing.
let buffer = try result.generateMaskedImage(ofInstances: result.allInstances, from: handler, croppedToInstancesExtent: true)
var cut = CIImage(cvPixelBuffer: buffer)
let scale = min(1, maxSide / max(cut.extent.width, cut.extent.height))
cut = cut.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
let ctx = CIContext()
let cg = ctx.createCGImage(cut, from: cut.extent)!
let rep = NSBitmapImageRep(cgImage: cg)
try rep.representation(using: .png, properties: [:])!.write(to: output)
print("\(args[2]): \(cg.width)x\(cg.height), \(result.allInstances.count) instance(s)")
