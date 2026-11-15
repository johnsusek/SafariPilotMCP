import AppKit
import Sparkle

/// Sparkle's updater, observable so the menu item and the settings toggle follow its state.
@MainActor @Observable final class Updates {
  @ObservationIgnored let controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
  var canCheck = false
  var automatic: Bool { didSet { controller.updater.automaticallyChecksForUpdates = automatic } }
  @ObservationIgnored private var observation: NSKeyValueObservation?

  init() {
    automatic = controller.updater.automaticallyChecksForUpdates
    observation = controller.updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] updater, _ in
      MainActor.assumeIsolated { self?.canCheck = updater.canCheckForUpdates }
    }
  }

  func check() {
    NSApp.activate()
    controller.updater.checkForUpdates()
  }
}
