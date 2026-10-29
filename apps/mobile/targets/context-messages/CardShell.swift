import Messages
import UIKit
import WebKit

/// What a card's page may ask the phone for, beyond sending a card back.
///
/// The extension is compiled, so every ability a page might want is built in
/// here once (the owner, 2026-10-29: "package everything we think we might
/// need, like haptics"), and new card formats are then pages on context.lc
/// that use them, shipped with a deploy. A page learns what this build offers
/// from `window.contextShell` before its own script runs, so a page written
/// for a later build can check before asking.
///
/// Each request is small and stays inside the conversation or the phone:
/// words for the text field or the clipboard, the share sheet, a haptic tap,
/// closing or resizing the panel. None reaches another person without the
/// person's own tap on Send. The one that reads anything back is `fetch`: the
/// person's own data from the gateway's `/cards/`, on their own phone, through
/// the key in CardGrant.swift, which the page never sees.
/// The camera, microphone, photos and location are not requests here: the
/// page uses the web's own (`<input type=file>`, `getUserMedia`,
/// `navigator.geolocation`), each behind iOS's permission prompt, which the
/// extension's Info.plist words.
enum CardShell {
  static let version = 2
  static let abilities = [
    "send", "insert", "live", "size", "open", "close", "haptic", "copy", "insertText", "share",
    "camera", "microphone", "photos", "location", "bubble", "fetch",
  ]
  static let maxText = 2000

  /// Runs before the page's own script, outside its content policy.
  static var userScript: WKUserScript {
    let list = abilities.map { "\"\($0)\"" }.joined(separator: ",")
    let source = "window.contextShell = Object.freeze({ version: \(version), abilities: Object.freeze([\(list)]) });"
    return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
  }

  static func text(_ body: [String: Any]) -> String? {
    guard let text = body["text"] as? String, !text.isEmpty, text.count <= maxText else { return nil }
    return text
  }

  static func haptic(_ style: String?) {
    switch style {
    case "success", "warning", "error":
      let kind: UINotificationFeedbackGenerator.FeedbackType = style == "success" ? .success : style == "warning" ? .warning : .error
      UINotificationFeedbackGenerator().notificationOccurred(kind)
    case "selection":
      UISelectionFeedbackGenerator().selectionChanged()
    case "medium":
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    case "heavy":
      UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
    default:
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
  }

  /// A live bubble's height, from the card's own `bh` (points), clamped.
  static func bubbleHeight(for url: URL?) -> CGFloat {
    let value = url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "bh" })?.value }
    guard let raw = value, let n = Double(raw) else { return 160 }
    return CGFloat(min(max(n, 60), 400))
  }
}

extension MessagesViewController {
  /// The requests beyond send, insert and size; false for one this build does not know.
  func handleShellRequest(_ kind: String, _ body: [String: Any]) -> Bool {
    switch kind {
    case "open":
      // A note or page in the app; only context.lc addresses.
      guard let address = body["url"] as? String, address.count <= 2048, let url = URL(string: address), Self.isContextLink(url) else { return true }
      extensionContext?.open(url, completionHandler: nil)
    case "close":
      dismiss()
    case "haptic":
      CardShell.haptic(body["style"] as? String)
    case "copy":
      guard let text = CardShell.text(body) else { return true }
      UIPasteboard.general.string = text
    case "insertText":
      // Goes in the text field; the person still taps Send.
      guard let text = CardShell.text(body) else { return true }
      activeConversation?.insertText(text, completionHandler: nil)
    case "share":
      var items: [Any] = []
      if let text = CardShell.text(body) { items.append(text) }
      if let address = body["url"] as? String, address.count <= 2048, let url = URL(string: address), url.scheme == "https" { items.append(url) }
      guard !items.isEmpty else { return true }
      let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
      sheet.popoverPresentationController?.sourceView = view
      present(sheet, animated: true)
    case "fetch":
      // The person's own data through the card key (CardGrant.swift); the answer goes to `contextCardResponse`.
      guard let id = body["id"] as? String, id.count <= 64, let path = body["path"] as? String else { return true }
      let method = (body["method"] as? String) == "POST" ? "POST" : "GET"
      let payload = body["body"] as? String
      if let payload = payload, payload.utf8.count > CardGrant.maxBody { return true }
      Task { [weak self] in
        let (status, text) = await CardGrant.shared.fetch(path: path, method: method, body: method == "POST" ? payload : nil)
        guard let args = try? JSONSerialization.data(withJSONObject: [id, status, text] as [Any]),
          let list = String(data: args, encoding: .utf8)
        else { return }
        await MainActor.run {
          self?.answerPage("window.contextCardResponse && window.contextCardResponse.apply(null, \(list))")
        }
      }
    default:
      return false
    }
    return true
  }
}
