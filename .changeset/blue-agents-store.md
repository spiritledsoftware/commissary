---
"@commissary/core": minor
---

Publish the complete Core SQL Record catalog with explicit table and column names, portable storage types, primary keys, and bounded SQL key fields.

Core Record validation is now stricter: sequence, fence, counter, and expiry fields reject negative or non-integer values, while string primary-key fields reject values longer than 95 Unicode code points. Writes using such values now fail schema validation.
