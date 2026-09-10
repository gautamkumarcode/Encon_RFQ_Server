const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config({ path: 'd:/Econ/Encon_admin/backend/.env' });

const PriceMasterSchema = new mongoose.Schema({ itemCode: String, item: String, price: Number, category: String }, { strict: false });
const PriceMaster = mongoose.model('PriceMaster', PriceMasterSchema, 'pricemasters');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const all = await PriceMaster.find({}).select('itemCode item price category').lean();
  console.log('Total count in pricemasters:', all.length);
  const sample = all.slice(0, 10);
  console.log('Sample items:', JSON.stringify(sample, null, 2));
  const matches = all.filter(i => (i.item || '').toLowerCase().includes('burner') || (i.item || '').toLowerCase().includes('alone') || (i.item || '').toLowerCase().includes('valve'));
  console.log('Matching burner/alone/valve items count:', matches.length);
  console.log('Matches sample:', JSON.stringify(matches.slice(0, 10), null, 2));
  process.exit(0);
}).catch(err => { console.error(err); process.exit(1); });
