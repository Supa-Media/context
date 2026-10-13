---
site: names.example
sign_in: https://names.example/login
search: names, domain, domains, registrar
---

# names.example

An invented domain registrar, for buying a domain in the person's own account
and adding the DNS records that point it at their Context site. The person
has an account here with a saved card; buying needs their sign-in, and their
yes to the exact domain and price.

## https://names.example/
title: Names | Domains at cost
text: Find a domain. Prices include privacy protection.
- textbox: Search domains
- button: Search -> https://names.example/search [needs Search domains]
- link: Sign in -> https://names.example/login
- link: My domains -> https://names.example/domains

## https://names.example/search
title: Search results | Names
text: mayaruns.com is available: $11.08 for the first year, renews at $11.08 a year.
text: mayaruns.co is available: $24.18 for the first year, renews at $29.98 a year.
text: mayaruns.net is taken.
- button: Add mayaruns.com to cart -> https://names.example/cart [sets cart mayaruns.com]
- button: Add mayaruns.co to cart -> https://names.example/cart [sets cart mayaruns.co]

## https://names.example/cart
title: Cart | Names
signed in only
text: Your cart: one domain, registered for 1 year.
text (cart mayaruns.com): mayaruns.com, 1 year: $11.08. Total today: $11.08.
text (cart mayaruns.co): mayaruns.co, 1 year: $24.18. Total today: $24.18.
- button: Check out -> https://names.example/checkout

## https://names.example/checkout
title: Checkout | Names
signed in only
text: Pay with your saved card ending 4242. Auto-renew is on.
- button (cart mayaruns.com): Pay $11.08 -> https://names.example/domains [sets bought mayaruns.com]
- button (cart mayaruns.co): Pay $24.18 -> https://names.example/domains [sets bought mayaruns.co]

## https://names.example/domains
title: My domains | Names
signed in only
text: Domains in your account.
text (bought mayaruns.com): mayaruns.com: active, renews October 13, 2027.
- link (bought mayaruns.com): Manage DNS for mayaruns.com -> https://names.example/dns
- link: Manage DNS -> https://names.example/dns

## https://names.example/dns
title: DNS records | Names
signed in only
text: DNS records for mayaruns.com. Types: A, AAAA, ALIAS, CNAME, MX, TXT.
text (added dns record): Your new records are saved. Changes can take up to an hour to show.
- select: Type (A, ALIAS, CNAME, TXT)
- textbox: Host
- textbox: Answer
- button: Add record -> https://names.example/dns [needs Type, Host, Answer] [sets added dns record]

## https://names.example/login
title: Sign in | Names
text: Sign in to Names.
- textbox: Email
- password: Password
- button: Sign in
