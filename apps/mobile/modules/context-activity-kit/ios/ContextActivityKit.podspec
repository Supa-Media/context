require "json"

package = JSON.parse(File.read(File.join(__dir__, "..", "package.json")))

Pod::Spec.new do |s|
  s.name           = "ContextActivityKit"
  s.version        = package["version"]
  s.summary        = "Context meeting Live Activity bridge"
  s.description    = "A gated Expo module that owns Context's local ActivityKit lifecycle."
  s.license        = "MIT"
  s.author         = "Supa Media"
  s.homepage       = "https://context.lc"
  # The host still supports iOS 15.1. ActivityKit use is runtime-gated in every
  # Swift entry point, so declaring 16.1 here would make CocoaPods silently
  # filter the entire Expo module out of that otherwise valid host target.
  s.platforms      = { :ios => "15.1" }
  s.source         = { :git => "https://github.com/Supa-Media/context.git" }
  s.static_framework = true
  s.dependency "ExpoModulesCore"
  s.frameworks     = "ActivityKit", "WidgetKit"
  s.source_files   = "**/*.{h,m,mm,swift}"
end
