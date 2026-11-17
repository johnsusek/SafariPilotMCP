/// Why a call failed, in the terms a caller acts on: each code fixes whether repeating the same call unchanged is safe and could succeed, and the one step to take next.
/// web/src/shared/errorCodes.json holds the same table; the web side takes its type from it and ErrorCodeTests checks this enum against it.
enum ErrorCode: String, Codable, Sendable, CaseIterable {
  case invalidArgument = "invalid_argument"
  case staleRef = "stale_ref"
  case notActionable = "not_actionable"
  case noContentScript = "no_content_script"
  case siteAccessPrompt = "site_access_prompt"
  case siteAccessDenied = "site_access_denied"
  case dialogOpen = "dialog_open"
  case tabUnavailable = "tab_unavailable"
  case approvalRequired = "approval_required"
  case accessibilityDenied = "accessibility_denied"
  case appUnavailable = "app_unavailable"
  case buildMismatch = "build_mismatch"
  case safariUnavailable = "safari_unavailable"
  case inputUnconfirmed = "input_unconfirmed"
  case notAWebPage = "not_a_web_page"
  case pageBusy = "page_busy"
  case waitTimeout = "wait_timeout"
  case timedOut = "timed_out"
  case failed

  enum Next: String, Codable, Sendable, CaseIterable {
    case fixInput = "fix_input", retry, readPage = "read_page", handleDialog = "handle_dialog", tabsList = "tabs_list", tabCreate = "tab_create", askUser = "ask_user", readMessage = "read_message", screenshot
  }

  /// Only a refusal made before anything reached the page, or a call that only reads, may be repeated as it was; anything that may already have acted is not.
  var retryable: Bool { self == .pageBusy || self == .waitTimeout }

  var next: Next {
    switch self {
    case .invalidArgument: .fixInput
    case .staleRef, .notActionable, .inputUnconfirmed, .waitTimeout, .timedOut: .readPage
    case .noContentScript: .tabCreate
    case .siteAccessPrompt, .siteAccessDenied, .approvalRequired, .accessibilityDenied, .appUnavailable, .buildMismatch, .safariUnavailable: .askUser
    case .dialogOpen: .handleDialog
    case .tabUnavailable: .tabsList
    case .pageBusy: .retry
    case .notAWebPage: .screenshot
    case .failed: .readMessage
    }
  }

  /// The code a thrown error carries; errors that are not SafariPilot's own, such as a decoding error, are failed.
  init(of error: any Error) {
    switch error {
    case let failure as Failure: self = failure.code
    case is BuildMismatch: self = .buildMismatch
    default: self = .failed
    }
  }
}
