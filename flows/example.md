---
id: implement-and-review
title: Implement and review
nodes:
  - id: build
    agent: implementer
  - id: review
    agent: reviewer
edges:
  - from: build
    to: review
    kind: hands_off_to
  - from: review
    to: build
    kind: reviews
---

# Implement and review

The implementer builds the change, then hands it to the reviewer. The reviewer
reports findings back to the implementer.
