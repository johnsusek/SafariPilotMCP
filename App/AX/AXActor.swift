import Dispatch

/// Where Accessibility work runs. Each AX call is synchronous IPC to Safari that waits up to its 3 s messaging timeout, and matching one element
/// reads thousands, so they stay off the main actor: a slow or hung Safari then cannot stall the app's window, its listener or the extension's polls.
@globalActor
actor AXActor {
  static let shared = AXActor()

  private static let queue = DispatchSerialQueue(label: "net.johnsolo.SafariPilot.accessibility")

  nonisolated var unownedExecutor: UnownedSerialExecutor { Self.queue.asUnownedSerialExecutor() }
}
