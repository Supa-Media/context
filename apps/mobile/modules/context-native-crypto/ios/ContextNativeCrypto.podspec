Pod::Spec.new do |s|
  s.name           = 'ContextNativeCrypto'
  s.version        = '1.0.0'
  s.summary        = 'Context iOS passphrase cryptography'
  s.description    = 'Argon2id and AES-256-GCM primitives for passphrase-locked notes.'
  s.author         = 'Supa Media'
  s.homepage       = 'https://github.com/Supa-Media/context'
  s.license        = {
    type: 'MIT AND (CC0-1.0 OR Apache-2.0)',
    file: 'LICENSES.md'
  }
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.source         = { git: 'https://github.com/Supa-Media/context.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # P-H-C/phc-winner-argon2, release 20190702 (commit 62358ba), is vendored
  # under vendor/argon2 with its dual CC0/Apache-2.0 license. CryptoKit supplies
  # AES-GCM, so this module adds no runtime dependency and no permission.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/vendor/argon2/include" "$(PODS_TARGET_SRCROOT)/vendor/argon2/src"',
  }

  s.source_files = "**/*.{h,c,swift}"
  s.public_header_files = "vendor/argon2/include/argon2.h"
  s.preserve_paths = "LICENSES.md", "vendor/argon2/LICENSE", "vendor/argon2/SHA256SUMS"
end
