import Messages
import UIKit

/// The Context cards in Messages (apps/agent/src/appCards.ts, pickCard.ts).
///
/// A note card carries the note's link: tapping it opens the note. A pick
/// card follows a set of option cards Tex texted and carries the options in
/// its URL (`https://context.lc/tex/pick?p=1&o=…&o=…`): tapping it lists them,
/// and choosing one sends the card back with `&c=<number>`, which reaches Tex
/// as "I pick 2: …". An ask card (`/tex/ask?k=…`) sits under something Tex
/// would send for them: Yes or Not now sends it back with `&c=1` or `&c=2`,
/// read as "yes" or "no" (apps/agent/src/cardChats.ts). Opened from the app
/// drawer with no card, it offers to tell Tex this phone has the app
/// (`/tex/hello`), after which Tex sends cards to tap. Only links on
/// context.lc are opened or read; anything else in a card's URL is ignored.
final class MessagesViewController: MSMessagesAppViewController {
  private let label = UILabel()
  private let stack = UIStackView()
  private var pick: Pick?
  private var answering: (url: URL, session: MSSession?)?

  static let helloURL = URL(string: "https://context.lc/tex/hello")!

  override func viewDidLoad() {
    super.viewDidLoad()
    label.text = "In your chat with Tex, Context cards let you answer with a tap: choose one of Tex's options, say yes to an email, or open a note."
    label.textAlignment = .center
    label.numberOfLines = 0
    label.textColor = .secondaryLabel
    stack.axis = .vertical
    stack.spacing = 10
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.addArrangedSubview(label)
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
    ])
  }

  override func willBecomeActive(with conversation: MSConversation) {
    super.willBecomeActive(with: conversation)
    if let message = conversation.selectedMessage {
      open(message)
    } else {
      showHello()
    }
  }

  override func didSelect(_ message: MSMessage, conversation: MSConversation) {
    super.didSelect(message, conversation: conversation)
    open(message)
  }

  private func open(_ message: MSMessage?) {
    guard let message = message, let url = message.url, Self.isContextLink(url) else { return }
    if let pick = Pick(url: url) {
      show(pick, from: message)
      return
    }
    if url.path == "/tex/ask" {
      showAsk(url, from: message)
      return
    }
    if url.path == "/tex/hello" {
      label.text = "Tex knows this phone has Context, so it sends cards you can tap."
      return
    }
    label.text = "Opening in Context…"
    extensionContext?.open(url) { [weak self] opened in
      if !opened {
        DispatchQueue.main.async { self?.label.text = url.absoluteString }
      }
    }
  }

  private func clearButtons() {
    for old in stack.arrangedSubviews where old !== label {
      stack.removeArrangedSubview(old)
      old.removeFromSuperview()
    }
  }

  private func addButton(_ title: String, tag: Int, action: Selector) {
    let button = UIButton(type: .system)
    button.setTitle(title, for: .normal)
    button.titleLabel?.font = .preferredFont(forTextStyle: .body)
    button.titleLabel?.numberOfLines = 2
    button.contentHorizontalAlignment = .leading
    button.tag = tag
    button.addTarget(self, action: action, for: .touchUpInside)
    stack.addArrangedSubview(button)
  }

  // MARK: The drawer: telling Tex this phone has the app

  private func showHello() {
    clearButtons()
    addButton("Turn on cards with Tex", tag: 0, action: #selector(sayHello))
  }

  /// Puts the hello card in the text field rather than sending it: they send
  /// it themselves, so it never goes to a chat they did not mean.
  @objc private func sayHello() {
    guard let conversation = activeConversation else { return }
    let message = MSMessage(session: MSSession())
    message.url = Self.helloURL
    let layout = MSMessageTemplateLayout()
    layout.caption = "Context cards on"
    layout.subcaption = "Tex can send cards to tap"
    message.layout = layout
    message.summaryText = "Turned on Context cards"
    conversation.insert(message) { [weak self] error in
      DispatchQueue.main.async {
        self?.label.text = error == nil ? "Send it to Tex to turn cards on." : "That didn't work. Try again from your chat with Tex."
        if error == nil { self?.dismiss() }
      }
    }
  }

  // MARK: Ask cards

  private func showAsk(_ url: URL, from message: MSMessage) {
    answering = (url, message.session)
    clearButtons()
    label.text = "Go ahead with what Tex asked?"
    addButton("Yes, go ahead", tag: 1, action: #selector(answer(_:)))
    addButton("Not now", tag: 2, action: #selector(answer(_:)))
    requestPresentationStyle(.compact)
  }

  @objc private func answer(_ sender: UIButton) {
    guard let answering = answering, let conversation = activeConversation, let url = withChoice(answering.url, sender.tag) else { return }
    let yes = sender.tag == 1
    let message = MSMessage(session: answering.session ?? MSSession())
    message.url = url
    let layout = MSMessageTemplateLayout()
    layout.caption = yes ? "Yes, go ahead" : "Not now"
    message.layout = layout
    message.summaryText = yes ? "Yes" : "Not now"
    conversation.send(message) { [weak self] error in
      DispatchQueue.main.async {
        if error == nil {
          self?.dismiss()
        } else {
          self?.label.text = yes ? "That didn't send. Reply yes instead." : "That didn't send. Reply no instead."
        }
      }
    }
  }

  // MARK: Pick cards

  private func show(_ pick: Pick, from message: MSMessage) {
    self.pick = Pick(url: pick.url, options: pick.options, texPick: pick.texPick, chosen: pick.chosen, session: message.session)
    clearButtons()
    label.text = pick.chosen.map { "You picked \(pick.options[$0 - 1]). Choose again?" } ?? "Which one?"
    for (index, name) in pick.options.enumerated() {
      let number = index + 1
      var title = "\(number). \(name)"
      if number == pick.texPick { title += "  ·  Tex's pick" }
      if number == pick.chosen { title = "✓ " + title }
      addButton(title, tag: number, action: #selector(choose(_:)))
    }
    requestPresentationStyle(.expanded)
  }

  @objc private func choose(_ sender: UIButton) {
    guard let pick = pick, let conversation = activeConversation, let url = pick.chosenURL(sender.tag) else { return }
    let name = pick.options[sender.tag - 1]
    let message = MSMessage(session: pick.session ?? MSSession())
    message.url = url
    let layout = MSMessageTemplateLayout()
    layout.caption = "Picked: \(name)"
    layout.subcaption = "Option \(sender.tag) of \(pick.options.count)"
    message.layout = layout
    message.summaryText = "Picked \(name)"
    conversation.send(message) { [weak self] error in
      DispatchQueue.main.async {
        if error == nil {
          self?.dismiss()
        } else {
          self?.label.text = "That didn't send. Reply \(sender.tag) instead."
        }
      }
    }
  }

  static func isContextLink(_ url: URL) -> Bool {
    guard url.scheme == "https", let host = url.host?.lowercased() else { return false }
    return host == "context.lc" || host.hasSuffix(".context.lc")
  }
}

/// A pick card's state, read from its URL: the options in order, Tex's pick
/// and, once they chose, their choice (all numbered from 1).
struct Pick {
  let url: URL
  let options: [String]
  let texPick: Int?
  let chosen: Int?
  var session: MSSession?

  init(url: URL, options: [String], texPick: Int?, chosen: Int?, session: MSSession?) {
    self.url = url
    self.options = options
    self.texPick = texPick
    self.chosen = chosen
    self.session = session
  }

  init?(url: URL) {
    guard url.path == "/tex/pick",
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
    else { return nil }
    let options = items.filter { $0.name == "o" }.compactMap { $0.value }.filter { !$0.isEmpty }.prefix(8)
    guard options.count >= 2 else { return nil }
    let number = { (name: String) -> Int? in
      guard let value = items.first(where: { $0.name == name })?.value, let n = Int(value), n >= 1, n <= options.count else { return nil }
      return n
    }
    self.init(url: url, options: Array(options), texPick: number("p"), chosen: number("c"), session: nil)
  }

  /// The card's URL with their choice in it.
  func chosenURL(_ number: Int) -> URL? {
    guard number >= 1, number <= options.count else { return nil }
    return withChoice(url, number)
  }
}

/// A card's URL with `c=<number>` set, every other part kept as it was written.
func withChoice(_ url: URL, _ number: Int) -> URL? {
  guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
  var items = (components.percentEncodedQueryItems ?? []).filter { $0.name != "c" }
  items.append(URLQueryItem(name: "c", value: String(number)))
  components.percentEncodedQueryItems = items
  return components.url
}
