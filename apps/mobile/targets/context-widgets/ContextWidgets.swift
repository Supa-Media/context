import SwiftUI
import WidgetKit

@main
struct ContextWidgets: WidgetBundle {
  var body: some Widget {
    ContextQuickCaptureWidget()
    if #available(iOSApplicationExtension 16.1, *) {
      ContextMeetingLiveActivity()
    }
  }
}
