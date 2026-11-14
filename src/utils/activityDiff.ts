// Audit-summary diff used by RFQ_UPDATED activity logs.
//
// The enquiry edit form posts the whole record back on every Save Changes, so
// logging req.body claimed that every field had changed on every save. That
// made the feed read as if the people named in the Assignee / Sales fields had
// performed the edit, when in fact only a call date moved. Compare the payload
// against the stored document and report only what actually changed.

// Not user edits, or already represented by the RFQ timeline.
const ACTIVITY_DIFF_IGNORE = new Set([
	"id",
	"_id",
	"rfqId",
	"createdAt",
	"updatedAt",
	"__v",
	"followups",
	"followupRemarks",
	"remarks",
	"attachments",
	"emailBody",
	"history",
	"daysOpen",
	"ageClass",
	"followupDue",
	"isMappedToOffer",
	"tentativeOfferDate",
]);

export const stringifyActivityValue = (value: any): string => {
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	if (value === null || value === undefined) return "";
	// ObjectIds reach the client as hex strings and come back the same way, so
	// compare them as hex. JSON.stringify would render {"$oid": "..."} and make
	// every assignment id look changed on a save that changed nothing.
	if (typeof value === "object" && typeof value.toHexString === "function") {
		return value.toHexString();
	}
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
};

// "2026-11-12", a Date for that day and a full ISO timestamp all describe the
// same stored value, so they must not be reported as a change.
const dayOf = (value: any): string | null => {
	const text = stringifyActivityValue(value);
	return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
};

export const diffEnquiryFields = (
	before: any,
	after: any,
): Record<string, any> => {
	const changed: Record<string, any> = {};
	if (!after || typeof after !== "object") return changed;

	for (const [key, value] of Object.entries(after)) {
		if (ACTIVITY_DIFF_IGNORE.has(key)) continue;
		// Keys the stored record does not carry are form/enrichment extras that
		// never reach the document, so they are not edits worth reporting.
		if (!before || !(key in before)) continue;

		const previous = before[key];
		if (stringifyActivityValue(previous) === stringifyActivityValue(value)) {
			continue;
		}

		const previousDay = dayOf(previous);
		const nextDay = dayOf(value);
		if (previousDay && nextDay && previousDay === nextDay) continue;

		changed[key] = value ?? "";
	}
	return changed;
};
