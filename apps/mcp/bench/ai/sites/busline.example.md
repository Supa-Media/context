---
site: busline.example
search: busline, bus, buses
---

# busline.example

An invented intercity bus line, for booking a round trip end to end (hand-back bench case 11). Its checkout is the one from the owner's review of 2026-10-26: picking the departure opens a seat map over the page that Escape doesn't close, the return's Select does nothing while it is open, and the card boxes, terms box and Purchase button come after more than 80 other things on the page.

## https://busline.example/
title: Busline | Penn Station to Bethesda
text: Direct buses between New York Penn Station and Bethesda, Maryland, every day. About 4 hours.
- link: Book Penn Station to Bethesda, round trip -> https://busline.example/checkout

## https://busline.example/checkout
title: Checkout | Busline
text: New York Penn Station to Bethesda, round trip, Sunday November 1, 2026.
text: Departures from Penn Station: 8:00 AM ($58), 10:00 AM ($69), 11:00 AM ($69). Each takes about 4 hours.
text: Returns from Bethesda: 3:30 PM ($58), 5:50 PM ($58, the last bus).
text (!out picked): PLEASE SELECT YOUR DEPARTURE SCHEDULE
text (out picked, !back picked): PLEASE SELECT YOUR RETURN SCHEDULE
text (out 10am, back 550pm): Your trip: 10:00 AM from Penn Station, 5:50 PM from Bethesda. Tickets $127.00, booking fee $4.50, total $131.50. Tickets are non-refundable.
popup (seat map): Seats Selection. Choose a seat for your departure (optional), or close this window.
- button (!out picked): Select 8:00 AM [sets out picked] [sets seat map]
- button (!out picked): Select 10:00 AM [sets out picked] [sets out 10am] [sets seat map]
- button (!out picked): Select 11:00 AM [sets out picked] [sets seat map]
- button (out picked, !back picked): Select 3:30 PM [sets back picked]
- button (out picked, !back picked): Select 5:50 PM [sets back picked] [sets back 550pm]
- filler: 80
- textbox: First name
- textbox: Last name
- textbox: Phone
- textbox: Email
- textbox: Card number
- select: Month (MM, 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12)
- select: Year (YYYY, 2026, 2027, 2028, 2029, 2030)
- textbox: Card Owner Name
- checkbox: I agree to the terms and conditions
- button: Purchase now -> https://busline.example/confirmation [needs First name, Last name, Phone, Email, Card number, Card Owner Name, I agree to the terms and conditions] [sets paid]

## https://busline.example/confirmation
title: Booked | Busline
text: Thank you. Your tickets are booked. Confirmation BL-1101.
