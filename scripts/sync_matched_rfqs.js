/**
 * Script: sync_matched_rfqs.js
 * 
 * Purpose:
 * Updates ONLY existing RFQs in MongoDB that match client emails and requirement descriptions.
 * - Disambiguates multiple RFQs for the same client email using subject / requirement similarity.
 * - Updates only: status, remarks, assignedTo, and salesResponsibility.
 * - DOES NOT create any new RFQs.
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('../node_modules/mongoose');
const dotenv = require('../node_modules/dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });

function cleanEmail(str) {
  if (!str) return '';
  const m = str.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (m) return m[1].toLowerCase().trim();
  return str.toLowerCase().trim();
}

function normalizeStatus(str) {
  if (!str) return 'Open';
  const s = str.trim().toLowerCase();
  if (s === 'offer sent' || s === 'offersent') return 'Offer Sent';
  if (s === 'regret') return 'REGRET';
  if (s === 'closed' || s === 'clossed') return 'Closed';
  if (s.includes('hold') || s.includes('discussion')) return 'Hold';
  if (s === 'under review') return 'Under review';
  return 'Open';
}

const ASSIGNEE_MAP = {
  'vijaya sir': 'Vijay Prasad',
  'vijay sir': 'Vijay Prasad',
  'vijya sir': 'Vijay Prasad',
  'vijya': 'Vijay Prasad',
  'vijay': 'Vijay Prasad',
  'vp': 'Vijay Prasad',
  'kk sir': 'KK',
  'kk': 'KK',
  'k.k sir': 'KK',
  'k. k sir': 'KK',
  'krishan kumar': 'KK',
  'nutan': 'Nutan Kumari',
  'dhananjay': 'Dhananjay',
  'dhanajay': 'Dhananjay',
  'dhananjay kumar': 'Dhananjay',
  'jyoti': 'Jyoti',
  'jyotirmy': 'Jyoti',
  'raju sir': 'Rajendran Krup',
  'rajendran': 'Rajendran Krup',
  'j.p sir': 'JP Sir',
  'jp sir': 'JP Sir',
  'jp singh': 'JP Sir',
  'jps': 'JP Sir',
  'pm sir': 'Puneet Mahender',
  'puneet sir': 'Puneet Mahender',
  'puneet sir.': 'Puneet Mahender',
  'pm': 'Puneet Mahender',
  'b.prasad': 'B. Prasad',
  'shikha': 'Shikha Sharma',
  'shikha sharma': 'Shikha Sharma',
  'shikha maam': 'Shikha Sharma',
  'shikha/ anjan sir': 'Shikha / Anjan Sir',
  'shikha/anjan sir': 'Shikha / Anjan Sir',
  'anjan sir / shikha': 'Shikha / Anjan Sir',
  'anjan sir/shikha': 'Shikha / Anjan Sir',
  'anjan & shikha': 'Shikha / Anjan Sir',
  'anjan/shikha': 'Shikha / Anjan Sir',
  'anjan sir': 'Anjan Sir',
  'kk sir/nutan': 'KK / Nutan',
  'kk/nutan': 'KK / Nutan',
  'k.k sir/nutan': 'KK / Nutan',
  'nutan/kk sir': 'KK / Nutan',
  'nutan/kk': 'KK / Nutan',
  'akshit/nutan': 'Akshit / Nutan',
  'dhananjay/puneet sir': 'Dhananjay / Puneet Sir',
  'puneet sir/ vijaya sir': 'Puneet Sir / Vijay Prasad',
  'puneet sir / vijaya sir': 'Puneet Sir / Vijay Prasad',
  'puneet sir/vijay sir': 'Puneet Sir / Vijay Prasad',
  'vijay sir/nutan': 'Vijay Prasad / Nutan',
  'jyoti/rupa': 'Jyoti / Rupa',
  'pm sir/dhananjay': 'PM Sir / Dhananjay',
  'ankit/dhananjay': 'Ankit / Dhananjay',
  'jagdeep/kk sir': 'Jagdeep / KK',
  'mr. sarkar sir/shikha': 'Sarkar Sir / Shikha',
  'sarkar sir': 'Sarkar Sir',
  'biswajit': 'Biswajit',
  'prince': 'Prince',
  'prins': 'Prince',
  'akshit': 'Akshit',
  'jagdeep': 'Jagdeep',
  'jagdeep singh': 'Jagdeep Singh',
  'tukaram': 'Tukaram',
  'manoj': 'Manoj'
};

function standardizeAssignee(raw) {
  if (!raw) return '';
  const key = raw.trim().toLowerCase();
  return ASSIGNEE_MAP[key] || raw.trim();
}

function standardizeSales(raw) {
  if (!raw) return '';
  const s = raw.trim();
  const lower = s.toLowerCase();
  if (lower.includes('shikha')) return 'Shikha Sharma';
  if (lower.includes('jp') || lower.includes('jps')) return 'JP Sir';
  if (lower.includes('vijay') || lower === 'vp') return 'Vijay Prasad';
  if (lower.includes('anand')) return 'Anand';
  if (lower === 'pm') return 'Puneet Mahender';
  return s;
}

function calculateSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;
  const stopWords = new Set(['for', 'and', 'the', 'with', 'from', 'req', 'rfq', 'enquiry', 'inquiry', 're', 'fwd', 'to', 'of', 'in', 'on', 'at', 'is', 'a', 'an', 'per']);
  const words1 = text1.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stopWords.has(w));
  const words2 = text2.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stopWords.has(w));
  if (words1.length === 0 || words2.length === 0) return 0;

  let matches = 0;
  const set2 = new Set(words2);
  words1.forEach(w => {
    if (set2.has(w)) matches++;
  });

  return matches / Math.min(words1.length, words2.length);
}

async function runSync() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('❌ MONGODB_URI not found in environment!');
    process.exit(1);
  }

  console.log('Connecting to MongoDB Atlas...');
  await mongoose.connect(mongoUri);
  console.log('Connected.');

  const Enquiry = mongoose.model('Enquiry', new mongoose.Schema({}, { strict: false }), 'enquiries');

  const clientDetailsPath = path.join(__dirname, 'client_details.json');
  if (!fs.existsSync(clientDetailsPath)) {
    console.error('❌ client_details.json not found at', clientDetailsPath);
    process.exit(1);
  }

  const clientDetails = JSON.parse(fs.readFileSync(clientDetailsPath, 'utf8'));
  const validDetails = clientDetails.filter(d => d && (d['MAIL ID'] || d['COMPANY NAME']));

  // Fetch all existing enquiries from MongoDB
  const dbEnquiries = await Enquiry.find().lean();
  console.log(`Found ${dbEnquiries.length} enquiries in MongoDB.`);

  // Index DB records by clean email
  const dbByEmail = new Map();
  dbEnquiries.forEach(e => {
    const em = cleanEmail(e.email);
    if (em) {
      if (!dbByEmail.has(em)) dbByEmail.set(em, []);
      dbByEmail.get(em).push(e);
    }
  });

  const matchedDbIds = new Set();
  const matchedUpdates = [];

  // Pass 1: Match by exact email and disambiguate multiple requirements using description similarity
  validDetails.forEach(cd => {
    const cdEmail = cleanEmail(cd['MAIL ID']);
    if (!cdEmail) return;

    const dbList = dbByEmail.get(cdEmail);
    if (!dbList || dbList.length === 0) return;

    const cdDesc = String(cd['ITEM DESCRIPTION'] || cd['Item Description'] || '');
    const available = dbList.filter(e => !matchedDbIds.has(String(e._id)));
    if (available.length === 0) return;

    let matchedDb = null;
    if (available.length === 1) {
      matchedDb = available[0];
    } else {
      let bestSim = -1;
      available.forEach(cand => {
        const sim = calculateSimilarity(cdDesc, cand.itemDescription);
        if (sim > bestSim) {
          bestSim = sim;
          matchedDb = cand;
        }
      });
      if (!matchedDb) matchedDb = available[0];
    }

    if (matchedDb) {
      matchedDbIds.add(String(matchedDb._id));
      matchedUpdates.push({
        dbId: matchedDb._id,
        rfqId: matchedDb.rfqId,
        email: cdEmail,
        dbSubject: matchedDb.itemDescription,
        clientRequirement: cdDesc,
        status: normalizeStatus(cd['STATUS']),
        remarks: (cd['Remaks'] || cd['Remarks'] || '').trim(),
        assignedTo: standardizeAssignee(cd['ASSIGNE TO']),
        salesResponsibility: standardizeSales(cd['SALES RESPOSIBILTY'])
      });
    }
  });

  // Pass 2: Remaining unmatched DB records (e.g. Ariba proxy emails or domain variations)
  const remainingDb = dbEnquiries.filter(e => !matchedDbIds.has(String(e._id)));
  remainingDb.forEach(db => {
    const dbEmail = cleanEmail(db.email);
    const dbSubject = db.itemDescription || '';
    const dbContact = (db.contactPerson || '').toLowerCase();

    let bestCd = null;
    let bestScore = 0;

    validDetails.forEach(cd => {
      const cdDesc = String(cd['ITEM DESCRIPTION'] || '');
      const cdPerson = (cd['CONTACT PERSON'] || '').toLowerCase();
      const cdEmail = cleanEmail(cd['MAIL ID']);

      let score = 0;
      if (cdPerson.length > 4 && (dbContact.includes(cdPerson) || cdPerson.includes(dbContact))) score += 3;
      if (cdEmail.includes('@') && dbEmail.includes('@')) {
        const d1 = cdEmail.split('@')[1];
        const d2 = dbEmail.split('@')[1];
        if (d1 === d2 && !['gmail.com', 'yahoo.com'].includes(d1)) score += 2;
      }
      const sim = calculateSimilarity(cdDesc, dbSubject);
      if (sim > 0.3) score += sim * 4;

      if (score > bestScore && score >= 2) {
        bestScore = score;
        bestCd = cd;
      }
    });

    if (bestCd) {
      matchedDbIds.add(String(db._id));
      matchedUpdates.push({
        dbId: db._id,
        rfqId: db.rfqId,
        email: dbEmail,
        dbSubject: dbSubject,
        clientRequirement: bestCd['ITEM DESCRIPTION'] || '',
        status: normalizeStatus(bestCd['STATUS']),
        remarks: (bestCd['Remaks'] || bestCd['Remarks'] || '').trim(),
        assignedTo: standardizeAssignee(bestCd['ASSIGNE TO']),
        salesResponsibility: standardizeSales(bestCd['SALES RESPOSIBILTY'])
      });
    }
  });

  console.log(`Matched ${matchedUpdates.length} existing RFQs to update.`);
  console.log(`Remaining untouched RFQs in DB: ${dbEnquiries.length - matchedUpdates.length}`);
  console.log(`New RFQs created: 0 (Strictly updating existing RFQs only)\n`);

  // Execute updates directly on the matched enquiries
  let updateCount = 0;
  for (const item of matchedUpdates) {
    const updateFields = {
      status: item.status,
      remarks: item.remarks,
      followupRemarks: item.remarks || undefined,
      assignedTo: item.assignedTo,
      salesResponsibility: item.salesResponsibility
    };

    // Remove undefined
    Object.keys(updateFields).forEach(k => {
      if (updateFields[k] === undefined) delete updateFields[k];
    });

    await Enquiry.findByIdAndUpdate(item.dbId, { $set: updateFields });
    updateCount++;
    console.log(`[${item.rfqId}] Updated -> Status: "${item.status}", Assignee: "${item.assignedTo || '(none)'}", Sales: "${item.salesResponsibility || '(none)'}", Remarks: "${item.remarks || '(none)'}"`);
  }

  const finalTotal = await Enquiry.countDocuments();
  console.log(`\n✅ Successfully updated ${updateCount} RFQs.`);
  console.log(`Total RFQs in DB remains: ${finalTotal} (No new documents created).`);

  await mongoose.disconnect();
}

runSync().catch(err => {
  console.error('Error during sync:', err);
  process.exit(1);
});
