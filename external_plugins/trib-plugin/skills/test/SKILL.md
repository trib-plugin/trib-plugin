---
name: test
description: "Changes have been verified and need runtime testing before shipping. Use after verify passes."
---

## Internal — do not expose these steps to the user

1. Reload plugin or restart relevant service
2. Run each changed feature
3. Check for errors in logs

## Output — present this to the user

Report test results:
- What was tested
- What passed
- What failed (if any)

Failed → back to execute for fix.
All passed → proceed to ship.
