import AppKit
import CoreGraphics
import Foundation
import ImageIO

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let sourceURL = root.appendingPathComponent("src-tauri/icons/moss-icon-source.png")
let outputURL = root.appendingPathComponent("src/assets/moss-mark.png")

guard
    let imageSource = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(imageSource, 0, nil)
else {
    fatalError("Unable to read the approved MOSS icon source.")
}

let width = image.width
let height = image.height
let bytesPerRow = width * 4
var pixels = [UInt8](repeating: 0, count: height * bytesPerRow)
let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let context = CGContext(
    data: &pixels,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: bytesPerRow,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fatalError("Unable to decode the approved MOSS icon source.")
}
context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

var minX = width
var minY = height
var maxX = -1
var maxY = -1

for y in 0..<height {
    for x in 0..<width {
        let offset = y * bytesPerRow + x * 4
        let alpha = pixels[offset + 3]
        let alphaScale = max(Double(alpha), 1)
        let red = min(Double(pixels[offset]) / alphaScale, 1)
        let green = min(Double(pixels[offset + 1]) / alphaScale, 1)
        let blue = min(Double(pixels[offset + 2]) / alphaScale, 1)
        let luminance = (red + green + blue) / 3

        // The desktop icon intentionally includes a white tile. The in-product
        // mark keeps only the approved black/green artwork and negative space.
        let isTilePixel = alpha > 0 && luminance > 0.65
        if alpha == 0 || isTilePixel {
            pixels[offset] = 0
            pixels[offset + 1] = 0
            pixels[offset + 2] = 0
            pixels[offset + 3] = 0
            continue
        }

        minX = min(minX, x)
        minY = min(minY, y)
        maxX = max(maxX, x)
        maxY = max(maxY, y)
    }
}

guard maxX >= minX, maxY >= minY else {
    fatalError("The approved MOSS icon did not contain a visible mark.")
}

let outputWidth = maxX - minX + 1
let outputHeight = maxY - minY + 1
let outputBytesPerRow = outputWidth * 4
var outputPixels = [UInt8](repeating: 0, count: outputHeight * outputBytesPerRow)

for y in 0..<outputHeight {
    let sourceStart = (minY + y) * bytesPerRow + minX * 4
    let outputStart = y * outputBytesPerRow
    outputPixels.replaceSubrange(
        outputStart..<(outputStart + outputBytesPerRow),
        with: pixels[sourceStart..<(sourceStart + outputBytesPerRow)]
    )
}

let outputData = Data(outputPixels)
guard
    let provider = CGDataProvider(data: outputData as CFData),
    let outputImage = CGImage(
        width: outputWidth,
        height: outputHeight,
        bitsPerComponent: 8,
        bitsPerPixel: 32,
        bytesPerRow: outputBytesPerRow,
        space: colorSpace,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
        provider: provider,
        decode: nil,
        shouldInterpolate: true,
        intent: .defaultIntent
    )
else {
    fatalError("Unable to create the MOSS UI mark bitmap.")
}

let targetHeight = 248
let targetWidth = Int((Double(outputWidth) / Double(outputHeight) * Double(targetHeight)).rounded())
guard let scaledContext = CGContext(
    data: nil,
    width: targetWidth,
    height: targetHeight,
    bitsPerComponent: 8,
    bytesPerRow: targetWidth * 4,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fatalError("Unable to allocate the MOSS UI mark output.")
}
scaledContext.interpolationQuality = .high
scaledContext.draw(
    outputImage,
    in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight)
)
guard let scaledImage = scaledContext.makeImage() else {
    fatalError("Unable to resize the MOSS UI mark.")
}

let representation = NSBitmapImageRep(cgImage: scaledImage)
guard let png = representation.representation(using: .png, properties: [:]) else {
    fatalError("Unable to encode the MOSS UI mark.")
}

try FileManager.default.createDirectory(
    at: outputURL.deletingLastPathComponent(),
    withIntermediateDirectories: true
)
try png.write(to: outputURL, options: .atomic)
print("Generated \(outputURL.path) (\(targetWidth)x\(targetHeight)).")
