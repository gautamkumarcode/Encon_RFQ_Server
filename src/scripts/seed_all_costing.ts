import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { PriceMaster, InternalCostingSheet } from '../models';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/encon_admin';

async function runSeed() {
  try {
    console.log('Connecting to MongoDB:', MONGODB_URI.split('@')[1] || MONGODB_URI);
    await mongoose.connect(MONGODB_URI);

    const jsonPath = path.join(__dirname, '../data/offerGenSeedData.json');
    if (!fs.existsSync(jsonPath)) {
      console.error('Seed file not found:', jsonPath);
      process.exit(1);
    }

    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const { priceMaster = [], costingSheets = [] } = JSON.parse(raw);

    console.log(`Found ${priceMaster.length} Price Master items and ${costingSheets.length} Costing Sheets in seed file.`);

    let seededPriceCount = 0;
    for (const item of priceMaster) {
      if (!item.itemCode || !item.item) continue;
      await PriceMaster.findOneAndUpdate(
        { itemCode: item.itemCode },
        { ...item, createdBy: 'Full Offer Generator Seed' },
        { upsert: true, new: true }
      );
      seededPriceCount++;
    }

    let seededSheetCount = 0;
    for (const sheet of costingSheets) {
      if (!sheet.sheetCode || !sheet.title) continue;
      await InternalCostingSheet.findOneAndUpdate(
        { sheetCode: sheet.sheetCode },
        { ...sheet, createdBy: 'Full Offer Generator Seed' },
        { upsert: true, new: true }
      );
      seededSheetCount++;
    }

    console.log(`Successfully seeded ${seededPriceCount} Price Master Items and ${seededSheetCount} Costing Sheets into MongoDB!`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Seeding error:', err);
    process.exit(1);
  }
}

runSeed();
