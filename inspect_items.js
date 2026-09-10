const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config({ path: 'd:/Econ/Encon_admin/backend/.env' });

const PriceMasterSchema = new mongoose.Schema({ itemCode: String, item: String, price: Number, category: String, specification: String }, { strict: false });
const PriceMaster = mongoose.model('PriceMaster', PriceMasterSchema, 'pricemasters');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const items = await PriceMaster.find({ $or: [{ item: /burner/i }, { item: /alone/i }, { item: /oil/i }] }).limit(30);
  console.log('Found items:', items.map(i => ({ code: i.itemCode, item: i.item, price: i.price, category: i.category, spec: i.specification })));
  const totalCount = await PriceMaster.countDocuments();
  console.log('Total Price Master items:', totalCount);
  process.exit(0);
}).catch(err => { console.error(err); process.exit(1); });
