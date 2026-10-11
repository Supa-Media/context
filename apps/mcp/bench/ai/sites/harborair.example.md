---
site: harborair.example
sign_in: https://harborair.example/login
search: harbor, harborair, flights
---

# harborair.example

An invented airline, for finding a flight without booking one.

## https://harborair.example/
title: Harbor Air | Flights
text: Find a flight. Fares include one carry-on bag.
- textbox: From
- textbox: To
- textbox: Date
- button: Search flights -> https://harborair.example/results [needs From, To, Date]
- link: Sign in -> https://harborair.example/login

## https://harborair.example/results
title: Flights | Harbor Air
text: Lisbon (LIS) to London Heathrow (LHR), Saturday November 14, 2026.
text: HA 211 leaves 07:40, lands 10:15, 89 euros.
text: HA 215 leaves 13:05, lands 15:40, 124 euros.
text: HA 219 leaves 19:30, lands 22:05, 71 euros.
- button: Choose HA 211 -> https://harborair.example/checkout [sets started booking]
- button: Choose HA 215 -> https://harborair.example/checkout [sets started booking]
- button: Choose HA 219 -> https://harborair.example/checkout [sets started booking]

## https://harborair.example/checkout
title: Checkout | Harbor Air
signed in only
text: Passenger details and payment.
- textbox: Card number
- button: Pay

## https://harborair.example/login
title: Sign in | Harbor Air
text: Sign in to your Harbor Air account.
- textbox: Email
- password: Password
- button: Sign in
