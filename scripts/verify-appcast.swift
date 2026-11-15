// Usage: swift scripts/verify-appcast.swift appcast.xml SafariPilot-X.Y.Z.dmg SUPublicEDKey
// Fails unless the appcast's EdDSA signature for the DMG verifies against the public key the app ships, so a wrong signing key can't strand users on an old version.
import CryptoKit
import Foundation

let arguments = CommandLine.arguments
let appcast = try String(contentsOfFile: arguments[1], encoding: .utf8)
let dmg = try Data(contentsOf: URL(fileURLWithPath: arguments[2]))

guard let match = appcast.firstMatch(of: #/sparkle:edSignature="([^"]+)"/#), let signature = Data(base64Encoded: String(match.1)), let publicKey = Data(base64Encoded: arguments[3]) else {
  print("appcast has no edSignature, or the public key is not base64")
  exit(1)
}

guard try Curve25519.Signing.PublicKey(rawRepresentation: publicKey).isValidSignature(signature, for: dmg) else {
  print("appcast signature does not verify against SUPublicEDKey")
  exit(1)
}

print("appcast signature verified")
