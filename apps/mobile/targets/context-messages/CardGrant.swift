import Foundation
import Security

/// The card key: how a card's page shows the person's own data (their inbox,
/// their week) without the page ever holding a credential.
///
/// The owner chose the app's sign-in over a key in each card's link
/// (2026-10-29), so a card's data opens only on the phone of the person signed
/// in to Context. The app leaves one grant in its keychain, under its app
/// group, which only the app and this extension can read: a gateway OAuth grant
/// for this phone with its own revocable client and scopes, never the app's
/// session. It is JSON:
///
///     { "api": "https://…", "token": "https://…/oauth/token", "clientId": "…",
///       "accessToken": "cat_…", "expiresAt": <ms>, "refreshToken": "crt_…" }
///
/// Only this extension refreshes it, at the gateway's token endpoint with the
/// rotation that endpoint enforces, and writes the new pair back; the app only
/// writes a grant where there is none. A refresh the gateway refuses deletes
/// it, so the app mints another the next time it opens.
///
/// A page asks through the bridge (`fetch`) for a path under `/cards/` on the
/// grant's `api`, and gets back the status and body. The token is added here
/// and never reaches the page.
actor CardGrant {
  static let shared = CardGrant()

  struct Stored: Codable {
    var api: String
    var token: String
    var clientId: String
    var accessToken: String
    var expiresAt: Double
    var refreshToken: String
  }

  // expo-secure-store's layout for key "grant" in service "lc.context.cards" (`requireAuthentication` off).
  private static let service = "lc.context.cards:no-auth"
  private static let account = Data("grant".utf8)
  static let maxBody = 256 * 1024

  private var refreshing: Task<Stored?, Never>?

  /// A path a page may fetch: under `/cards/`, plain characters, no climbing out.
  static func isCardPath(_ path: String) -> Bool {
    guard path.hasPrefix("/cards/"), path.count <= 1024, !path.contains(".."), !path.contains("//") else { return false }
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "/-_.~?=&%+,:"))
    return path.unicodeScalars.allSatisfy { $0.isASCII && allowed.contains($0) }
  }

  /// The page's request with the grant added: (status, body). 401 with
  /// `{"error":"signed_out"}` when this phone has no grant.
  func fetch(path: String, method: String, body: String?) async -> (Int, String) {
    guard Self.isCardPath(path) else { return (400, #"{"error":"bad_path"}"#) }
    for attempt in 0..<2 {
      guard let grant = await current(forceRefresh: attempt > 0),
        let url = URL(string: (grant.api.hasSuffix("/") ? String(grant.api.dropLast()) : grant.api) + path), url.scheme == "https", url.path.hasPrefix(cardsRoot(grant.api))
      else { return (401, #"{"error":"signed_out"}"#) }
      var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
      request.httpMethod = method
      request.setValue("Bearer \(grant.accessToken)", forHTTPHeaderField: "Authorization")
      if let body = body {
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(body.utf8)
      }
      guard let (data, response) = try? await URLSession.shared.data(for: request),
        let status = (response as? HTTPURLResponse)?.statusCode
      else { return (0, #"{"error":"offline"}"#) }
      // A token the gateway no longer takes gets one refresh and one retry.
      if status == 401 && attempt == 0 { continue }
      let text = data.count <= Self.maxBody ? String(decoding: data, as: UTF8.self) : #"{"error":"too_large"}"#
      return (status, text)
    }
    return (401, #"{"error":"signed_out"}"#)
  }

  /// `/cards/` under the api's own path, so a page cannot reach anything else on the gateway.
  private func cardsRoot(_ api: String) -> String {
    let base = (URL(string: api)?.path ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    return base.isEmpty ? "/cards/" : "/\(base)/cards/"
  }

  /// The grant, refreshed when it is within a minute of expiring (or `forceRefresh`); one refresh at a time.
  private func current(forceRefresh: Bool) async -> Stored? {
    guard let stored = Self.read() else { return nil }
    let now = Date().timeIntervalSince1970 * 1000
    if !forceRefresh && stored.expiresAt - 60_000 > now { return stored }
    if let task = refreshing { return await task.value }
    let task = Task { await Self.refresh(stored) }
    refreshing = task
    let result = await task.value
    refreshing = nil
    return result
  }

  private static func refresh(_ stored: Stored) async -> Stored? {
    guard let url = URL(string: stored.token), url.scheme == "https" else { return nil }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = Data(form([
      ("grant_type", "refresh_token"), ("refresh_token", stored.refreshToken), ("client_id", stored.clientId),
    ]).utf8)
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      let status = (response as? HTTPURLResponse)?.statusCode
    else { return nil }  // Offline: keep the grant for next time.
    guard status == 200,
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let access = json["access_token"] as? String, let refresh = json["refresh_token"] as? String,
      let expiresIn = json["expires_in"] as? Double
    else {
      // Refused (revoked, or a rotated token reused): the app mints a new one when it next opens.
      if (400..<500).contains(status) { delete() }
      return nil
    }
    var next = stored
    next.accessToken = access
    next.refreshToken = refresh
    next.expiresAt = Date().timeIntervalSince1970 * 1000 + expiresIn * 1000
    write(next)
    return next
  }

  private static func form(_ pairs: [(String, String)]) -> String {
    let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
    return pairs.map { "\($0.0)=\($0.1.addingPercentEncoding(withAllowedCharacters: safe) ?? "")" }.joined(separator: "&")
  }

  // MARK: The keychain item

  private static var query: [String: Any]? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "ContextAppGroup") as? String, !group.isEmpty else { return nil }
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrGeneric as String: account,
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: group,
    ]
  }

  private static func read() -> Stored? {
    guard var query = query else { return nil }
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
      let stored = try? JSONDecoder().decode(Stored.self, from: data),
      URL(string: stored.api)?.scheme == "https"
    else { return nil }
    return stored
  }

  private static func write(_ stored: Stored) {
    guard let query = query, let data = try? JSONEncoder().encode(stored) else { return }
    SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
  }

  private static func delete() {
    guard let query = query else { return }
    SecItemDelete(query as CFDictionary)
  }
}
