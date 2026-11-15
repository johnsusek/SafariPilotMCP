import Foundation

/// Credentials in URLs are hidden only where text and data leave for the client: the app keeps real URLs for window matching, settle and its tab cache.
/// The rule is web/src/shared/redact.ts's, and both run the cases in web/src/shared/redactUrl.cases.json.
enum Redaction {
  static let hidden = "[hidden]"

  private static let secretWords: Set<String> = [
    "token", "secret", "password", "passwd", "pwd", "pass", "passcode", "key", "apikey", "sig", "signature", "auth", "authorization", "credential", "credentials",
    "session", "sessionid", "sid", "jwt", "otp", "oob", "ticket", "assertion", "bearer", "verifier", "saml", "samlresponse",
  ]

  /// Names run together as one word: accesstoken, PHPSESSID, jsessionid, clientsecret.
  private static let secretEndings = ["token", "secret", "password", "signature", "apikey", "sessid", "sessionid"]

  static func words(_ name: String) -> [String] {
    name.replacing(/([a-z0-9])([A-Z])/) { "\($0.1) \($0.2)" }
      .replacing(/([A-Z]+)([A-Z][a-z])/) { "\($0.1) \($0.2)" }
      .lowercased()
      .split(whereSeparator: { !("a" ... "z").contains($0) && !("0" ... "9").contains($0) })
      .map(String.init)
  }

  static func isSecretParameter(_ name: String) -> Bool {
    let words = words(name.removingPercentEncoding ?? name)
    let joined = words.joined()

    if joined == "code" { return true }

    return words.contains(where: secretWords.contains) || secretEndings.contains(where: joined.hasSuffix)
  }

  /// Userinfo and the values of secret-named query, fragment and ;path parameters become [hidden]; the rest stays as written.
  static func url(_ url: String) -> String {
    url.replacing(/^([a-zA-Z][a-zA-Z0-9+.\-]*:)?\/\/[^\/?#]*@/) { "\($0.1 ?? "")//\(hidden)@" }
      .replacing(/([?&#;])([^=?&#;]*)=([^?&#;]*)/) { match in
        match.3.isEmpty || !isSecretParameter(String(match.2)) ? String(match.0) : "\(match.1)\(match.2)=\(hidden)"
      }
  }

  /// Keys whose string values are URLs in the data a reply carries.
  private static let urlKeys: Set<String> = ["url", "src"]

  /// Hides credentials in every URL the data holds under a url or src key; other strings, such as a javascript result, stay as they are.
  static func data(_ value: JSONValue) -> JSONValue {
    switch value {
    case let .object(fields):
      .object(Dictionary(uniqueKeysWithValues: fields.map { key, field in
        guard urlKeys.contains(key), let text = field.string else { return (key, data(field)) }

        return (key, .string(url(text)))
      }))
    case let .array(items): .array(items.map(data))
    default: value
    }
  }
}

extension CLIReply {
  /// What the client receives: the text is composed with redacted URLs already, and the data's URLs are hidden here.
  var forClient: CLIReply { CLIReply(ok: ok, text: text, data: Redaction.data(data), code: code, timing: timing) }
}

extension TabInfo {
  var shownURL: String { Redaction.url(url) }
}
