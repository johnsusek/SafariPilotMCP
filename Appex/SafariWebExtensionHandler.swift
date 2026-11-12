import Foundation
import os
import SafariServices

/// Relays every native message from the background to SafariPilot.app over loopback TCP and returns the app's reply.
/// Polls are held open by the app for up to ~20s, so requests complete asynchronously off the calling thread.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
  private let log = Logger(subsystem: "net.johnsolo.SafariPilot.Extension", category: "relay")

  func beginRequest(with context: NSExtensionContext) {
    let message = (context.inputItems.first as? NSExtensionItem)?.userInfo?[SFExtensionMessageKey] ?? NSNull()
    let box = ContextBox(context: context)
    let request: Data

    do {
      request = try JSONSerialization.data(withJSONObject: message, options: [.fragmentsAllowed])
    } catch {
      box.complete(with: ["error": "appex could not encode message: \(error)"])
      return
    }

    let log = log

    Task.detached {
      do {
        let reply = try Wire.exchange(request, timeoutSeconds: 60)
        let object = try JSONSerialization.jsonObject(with: reply, options: [.fragmentsAllowed])
        box.complete(with: object)
      } catch {
        log.error("relay failed: \(String(describing: error), privacy: .public)")
        box.complete(with: ["error": "appex relay: \(error)"])
      }
    }
  }
}

/// NSExtensionContext is not Sendable; it is only touched once, to complete the request.
private struct ContextBox: @unchecked Sendable {
  let context: NSExtensionContext

  func complete(with object: Any) {
    let item = NSExtensionItem()
    item.userInfo = [SFExtensionMessageKey: object]
    context.completeRequest(returningItems: [item], completionHandler: nil)
  }
}
