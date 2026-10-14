# Library Management System - Updated Build

## Run locally
1. Create MySQL database using `database/schema.sql`.
2. Copy `.env.example` to `.env` and fill the MySQL credentials.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000`.

## Important biometric step
This build uses face-api.js 128-dimensional face descriptors instead of the old raw-image byte similarity. Existing enrolled photos can be converted from the Admin panel using **Sync Existing Faces**. New student/admin enrollment captures a face descriptor automatically.

For best biometric reliability, use good lighting, one visible face, and a live camera. This is stronger identity matching and basic liveness gating, but it is not certified anti-spoof hardware/face-recognition security.

## Production
- Never commit `.env`.
- Use a managed MySQL database and put its credentials in the host's environment variables.
- Use persistent/object storage for uploaded images if the host has ephemeral disks.
- Re-enroll/sync faces after migrating the uploads folder if biometric images change.

## Admin Fine Center (Updated)

The Admin → **Students FEEs & Fines** tab now includes a direct **Add Fine** workflow.

- **Manual Fine:** select any student, fine type, amount and reason.
- **Book Damage:** select a student + book transaction, enter the damage amount and reason.
- Every newly added fine is stored in `student_fines`.
- A **student-specific FEE notice** is created automatically.
- The fine appears in that student's **Fees & Fine Notices** and **Pay Fees** list only.
- The UPI QR is regenerated with the exact outstanding amount and student/fine context.
- The student submits the UTR; the payment clears the exact fine and creates the existing official receipt.
- Admin fee totals, itemized notices and activity logs include these manual fines.

The server automatically creates `student_fines` at startup for existing installations, and `database/schema.sql` contains the table for fresh installations.

## Responsive UI

The existing neon/cyber LMS visual language has been extended to the Fine Center. Admin and student portals keep the same animated/glass styling, while mobile screens switch to stacked sections with horizontally scrollable navigation and touch-friendly controls. Desktop uses the wider dashboard layout and mobile uses compact cards/tables with horizontal overflow where needed.
