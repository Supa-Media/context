import Messages
import UIKit

/// The Context card in Messages (apps/agent/src/appCards.ts): Tex texts a
/// note's link as a card, and tapping the card opens the note. Only a link
/// on context.lc is opened; anything else in a card's URL is ignored.
final class MessagesViewController: MSMessagesAppViewController {
  private let label = UILabel()

  override func viewDidLoad() {
    super.viewDidLoad()
    label.text = "Tap a Context card to open the note."
    label.textAlignment = .center
    label.numberOfLines = 0
    label.textColor = .secondaryLabel
    label.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
      label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
    ])
  }

  override func willBecomeActive(with conversation: MSConversation) {
    super.willBecomeActive(with: conversation)
    open(conversation.selectedMessage)
  }

  override func didSelect(_ message: MSMessage, conversation: MSConversation) {
    super.didSelect(message, conversation: conversation)
    open(message)
  }

  private func open(_ message: MSMessage?) {
    guard let url = message?.url, Self.isContextLink(url) else { return }
    label.text = "Opening in Context…"
    extensionContext?.open(url) { [weak self] opened in
      if !opened {
        DispatchQueue.main.async { self?.label.text = url.absoluteString }
      }
    }
  }

  static func isContextLink(_ url: URL) -> Bool {
    guard url.scheme == "https", let host = url.host?.lowercased() else { return false }
    return host == "context.lc" || host.hasSuffix(".context.lc")
  }
}
