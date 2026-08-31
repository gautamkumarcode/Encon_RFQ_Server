import sqlite3
import os

SOURCE_DB = r"d:\Econ\RfqProject\rfq.db"
TARGET_DB = r"d:\Econ\Encon_admin\backend\prisma\dev.db"

def migrate():
    if not os.path.exists(SOURCE_DB):
        print(f"Source DB not found at {SOURCE_DB}. Skipping migration.")
        return

    if not os.path.exists(TARGET_DB):
        print(f"Target DB not found at {TARGET_DB}. Please run prisma db push first.")
        return

    print("Connecting to source and target SQLite databases...")
    src_conn = sqlite3.connect(SOURCE_DB)
    tgt_conn = sqlite3.connect(TARGET_DB)

    src_conn.row_factory = sqlite3.Row
    src_cur = src_conn.cursor()
    tgt_cur = tgt_conn.cursor()

    # 1. Migrate Assignee Emails
    try:
        src_cur.execute("SELECT name, email FROM assignee_emails")
        assignees = src_cur.fetchall()
        print(f"Found {len(assignees)} assignee email records in source.")

        for row in assignees:
            name = row["name"]
            email = row["email"] or ""
            if name:
                tgt_cur.execute("""
                    INSERT INTO AssigneeEmail (name, email)
                    VALUES (?, ?)
                    ON CONFLICT(name) DO UPDATE SET email=excluded.email
                """, (name, email))
        print("Assignee emails migrated.")
    except Exception as e:
        print(f"Error migrating assignees: {e}")

    # 2. Migrate RFQ Counters
    try:
        src_cur.execute("SELECT year, last_seq FROM rfq_counters")
        counters = src_cur.fetchall()
        print(f"Found {len(counters)} RFQ counter records in source.")

        for row in counters:
            year = row["year"]
            last_seq = row["last_seq"] or 0
            if year:
                tgt_cur.execute("""
                    INSERT INTO RfqCounter (year, lastSeq)
                    VALUES (?, ?)
                    ON CONFLICT(year) DO UPDATE SET lastSeq=excluded.lastSeq
                """, (str(year), last_seq))
        print("RFQ counters migrated.")
    except Exception as e:
        print(f"Error migrating counters: {e}")

    # 3. Migrate Enquiries
    try:
        src_cur.execute("SELECT * FROM enquiries")
        enquiries = src_cur.fetchall()
        print(f"Found {len(enquiries)} enquiry records in source.")

        migrated_count = 0
        for row in enquiries:
            d = dict(row)
            eid = d.get("id")
            rfq_id = d.get("rfq_id") or ""
            date_received = d.get("date_received") or ""
            received_on = d.get("received_on") or ""
            etype = d.get("type") or ""
            company_name = d.get("company_name") or ""
            contact_person = d.get("contact_person") or ""
            mobile = d.get("mobile") or ""
            email = d.get("email") or ""
            item_description = d.get("item_description") or ""
            assigned_to = d.get("assigned_to") or ""
            assigned_date = d.get("assigned_date") or ""
            tat = d.get("tat") or ""
            sales_responsibility = d.get("sales_responsibility") or ""
            technical = d.get("technical") or ""
            status = d.get("status") or "Open"
            remarks = d.get("remarks") or ""
            followup_remarks = d.get("followup_remarks") or ""
            next_action_date = d.get("next_action_date") or ""
            proposed_offer_date = d.get("proposed_offer_date") or ""
            offer_no = d.get("offer_no") or ""
            offer_date = d.get("offer_date") or ""
            doc = d.get("doc") or ""
            costing = d.get("costing") or ""
            timeline = d.get("timeline") or ""
            costing_notified = d.get("costing_notified") or ""
            reminder_sent = d.get("reminder_sent") or ""
            drive_folder_id = d.get("drive_folder_id") or ""
            drive_folder_url = d.get("drive_folder_url") or ""
            source_message_id = d.get("source_message_id") or ""
            thread_id = d.get("thread_id") or ""
            email_body = d.get("email_body") or ""
            created_at = d.get("created_at") or "CURRENT_TIMESTAMP"

            tgt_cur.execute("""
                INSERT OR REPLACE INTO Enquiry (
                    id, rfqId, dateReceived, receivedOn, type, companyName, contactPerson,
                    mobile, email, itemDescription, assignedTo, assignedDate, tat,
                    salesResponsibility, technical, status, remarks, followupRemarks,
                    nextActionDate, proposedOfferDate, offerNo, offerDate, doc, costing,
                    timeline, costingNotified, reminderSent, driveFolderId, driveFolderUrl,
                    sourceMessageId, threadId, emailBody, createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """, (
                eid, rfq_id, date_received, received_on, etype, company_name, contact_person,
                mobile, email, item_description, assigned_to, assigned_date, tat,
                sales_responsibility, technical, status, remarks, followup_remarks,
                next_action_date, proposed_offer_date, offer_no, offer_date, doc, costing,
                timeline, costing_notified, reminder_sent, drive_folder_id, drive_folder_url,
                source_message_id, thread_id, email_body, created_at
            ))
            migrated_count += 1
        print(f"Migrated {migrated_count} enquiries.")
    except Exception as e:
        print(f"Error migrating enquiries: {e}")

    tgt_conn.commit()
    src_conn.close()
    tgt_conn.close()
    print("Migration complete!")

if __name__ == "__main__":
    migrate()
