# Walkthrough: Trial License Registration & Omnime Removal

The **OpalaCoder** suite has been streamlined by removing the `omnime` agent from the public website, and a new registered trial licensing feature has been introduced to allow users to generate test licenses during onboarding.

---

## 1. What was built

### A. Omnime Removal
- **Landing Page (`HomePage.jsx`)**: Removed the OmniMe footer link and description at the bottom of the page.
- **Language Context (`LanguageContext.jsx`)**: Removed the OmniMe product entry, pricing, and GitHub links from the translations object, and updated headings/FAQs/steps to remove references comparing the tools.

### B. Registered Trial Licensing (Remote Server - `OpalaWebPage`)
- **SQLite Schema Migration**: Added `expires_at` (DATETIME) and `status` (TEXT DEFAULT 'active') columns to the `licenses` table. Existing licenses default to `'active'` status and no expiration (lifetime).
- **New API Route (`POST /api/license/generate-trial`)**: Generates a trial license key prefixed with `OPALA-TRIAL-` that expires in 14 days, with a starting token balance of `0`.
- **Completions Proxy & Balance Check Validation**:
  - In `POST /api/chat-proxy/chat/completions`, checks if a license is expired (`status === 'expired'` or current time is past `expires_at`). If so, sets status to `'expired'` and rejects the request.
  - In `GET /api/get-balance`, verifies and updates the license status if expired and returns `status` and `expires_at` in the JSON response.
- **Checkout Recharge Safeguard**: In `/api/create-checkout-session`, blocks credit recharges on licenses that are already expired.

### C. Licensing Client Integration (OpalaTex Desktop)
- **Local Expiration Logic (`licensing.py`)**: Modified `check_license_status()` to inspect if the saved license is marked with `is_trial: True` and verify if the local machine time has passed the trial's Unix timestamp `expires_at`.
- **Local API Endpoint (`ide_server.py`)**: Added `POST /api/license/generate-trial`. It reaches out to the remote server to create the trial license and persists it locally to the encrypted `license.dat` file with `is_trial = True` and `expires_at = timestamp`.
- **Onboarding UI (`OnboardingModal.jsx`)**: Added a card inside the second step of the onboarding wizard. If no license key is present in the IDE, a "Gerar Licença Trial" button appears. Clicking it requests the license, activates it locally, and displays the active key in a monospace info box.
- **Internationalization**: Added Portuguese and English keys in locales JSON files.

---

## 2. Verification & Test Results

### A. Automated Tests
We created `tests/test_licensing.py` specifically to cover the new local client licensing checks:
- Verifies that `TRIAL_ACTIVE` is returned when the trial is within the valid duration.
- Verifies that `TRIAL_EXPIRED` is returned when the current time is past the stored `expires_at`.
- Verifies that a normal lifetime license returns `LICENSED` without expiration logic.

**Test run output:**
```bash
.venv\Scripts\python.exe -m pytest tests/test_licensing.py
...
tests\test_licensing.py .                                                [100%]
============================== 1 passed in 0.33s ==============================
```

### B. Manual Verification
- We verified the Express server startup, confirming that the database migration executes without issues and adds columns `expires_at` and `status` seamlessly to the existing schema.
- We tested hitting the trial generation endpoint on the server, which successfully inserted a row in `licenses` and returned the key:
  `{"success":true,"licenseKey":"OPALA-TRIAL-F3C5-863F-779A","expiresAtTs":1783997131}`
