# PayCalc Contract MVP

This is Joe's PayCalc upgraded into a first MVP workflow for contract generation and approval.

## What It Does

- Calculates travel/local pay packages from assignment details.
- Produces the existing approval email block.
- Produces the existing contract insert block.
- Provides manual contract fields for contractor address, facility address, RTO, and bonus.
- Generates a downloadable Word contract from `templates/contract-template.docx`.
- Opens an approval email draft with only the approval details.
- Includes a JobDiva import button backed by a configurable lookup endpoint.

## Run It

```bash
npm run dev
```

Open:

- `http://localhost:3000`

No install step is required for the current MVP because it uses only built-in Node.js modules.

## JobDiva Lookup

The app works without JobDiva credentials by returning demo data for the import button.

To connect a real source, copy the env example:

```bash
cp .env.example .env
```

Then set:

```bash
JOBDIVA_LOOKUP_URL=https://your-internal-endpoint.example.com/jobdiva
JOBDIVA_API_TOKEN=optional-token
```

The endpoint should accept `?jobId=12345` and return JSON like:

```json
{
  "contractorName": "Jane Doe",
  "contractorAddress1": "123 Main St",
  "contractorAddress2": "Columbus, OH 43215",
  "jobTitle": "CT Technologist",
  "facilityName": "Ohio State University Wexner Medical Center",
  "facilityAddress": "460 W 10th Ave",
  "facilityCity": "Columbus",
  "facilityState": "OH",
  "facilityZip": "43210",
  "startDate": "2026-06-01",
  "endDate": "2026-08-29",
  "schedule": "4x10",
  "shift": "Days",
  "billRate": 86,
  "hoursPerWeek": 40,
  "onCallBillRate": 12,
  "requestedTimeOff": "",
  "extensionBonus": 0,
  "payType": "TRAVEL"
}
```

## Word Contract Template

The app uses:

```text
templates/contract-template.docx
```

The generator fills camelCase placeholders in the Word document:

- contractor name and greeting
- contractor address
- contract date
- job title
- facility name
- facility address and city/state/ZIP
- assignment dates and duration
- schedule, shift, and hours
- gross weekly pay
- taxable hourly
- stipend
- on-call, callback, overtime, and holiday rates
- requested time off
- extension bonus

If `requestedTimeOff` is blank, that row is removed. If `extensionBonus` is blank or `0`, that row is removed.

## Next MVP Slice

Wire the manual fields to real JobDiva data, then attach the generated `.docx` to the approval email instead of only downloading it.
