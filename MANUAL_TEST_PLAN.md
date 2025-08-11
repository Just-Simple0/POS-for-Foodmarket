# Manual Test Plan: Monthly Visit Restriction

## Purpose
Confirm that customers cannot be processed more than once per month in `provision` flow.

## Preconditions
- At least one customer exists in Firestore `customers` collection.
- Customer has no visit recorded for the current month under the current fiscal year period key.

## Test Steps
1. **First Visit**
   1. Open `provision.html` in the browser and log in.
   2. Enter the customer's ID or name and click `lookup`.
   3. Verify the customer's information is shown and product selection section becomes visible.
   4. Select products totaling ≤30 points and submit.
   5. Observe a success toast and confirm the visit date is written to `visits[periodKey]`.
2. **Second Visit (same month)**
   1. Without altering Firestore, attempt another lookup for the same customer.
   2. Confirm a toast appears saying `이미 방문한 대상자입니다`.
   3. Ensure the product selection section remains hidden and submission is not possible.

## Expected Result
- First visit is logged normally.
- Any subsequent visit attempts within the same month display the warning toast and block product selection.
