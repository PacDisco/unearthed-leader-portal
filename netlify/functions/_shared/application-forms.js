// The Jotform form IDs that hold APPLICATION submissions.
//
// WHY THIS EXISTS: the same list was previously copy-pasted into
// get-application-data.js and get-students.js, and lib/jotform.js defaulted to
// a shorter list of its own. That was survivable while the list was only used
// for reads, but leader editing makes a mismatch dangerous: the modal would
// display the submission found by one list while the save wrote to whichever
// submission the other list resolved. Everything that resolves "this person's
// application" now imports from here so read and write always land on the
// same submission.
//
// Override with the JOTFORM_APPLICATION_FORM_ID env var (comma-separated).
// Add new IDs there when a new version of the application form is spun up, so
// students who used an older version don't drop out of the lookup.
//
// NOTE: the document-upload form (261220345497052) is deliberately NOT in this
// list. It also carries an email answer, so including it would let a more
// recent upload submission win over the real application.

export const APPLICATION_FORM_IDS = (process.env.JOTFORM_APPLICATION_FORM_ID
  || "251396787451873,253477140703050,260388618557066,250747665126866")
  .split(",").map(s => s.trim()).filter(Boolean);

// Same list in the comma-separated form the Jotform lib takes as an override.
export const APPLICATION_FORM_IDS_CSV = APPLICATION_FORM_IDS.join(",");
