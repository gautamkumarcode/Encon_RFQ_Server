import { Response } from 'express';
import { z, ZodError } from 'zod';
import { AuthenticatedRequest } from '../../middleware/authMiddleware';
import * as service from './pricing.service';
import {
  calculateSchema,
  createCostSchema,
  createItemSchema,
  createPriceSchema,
  createRuleSchema,
  importCommitSchema,
  importPreviewSchema,
  updateItemSchema,
  updateRuleSchema,
  PricingError,
} from './pricing.types';

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<Response | void>;

/** Wraps a handler with the module's error envelope (PricingError + Zod). */
const h =
  (fn: Handler): Handler =>
  async (req, res) => {
    try {
      return await fn(req, res);
    } catch (error: any) {
      if (error instanceof ZodError) {
        const issues = error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
        return res.status(400).json({ success: false, message: issues });
      }
      if (error instanceof PricingError) {
        return res
          .status(error.statusCode)
          .json({ success: false, code: error.code, message: error.message });
      }
      console.error('[pricingController]', error);
      return res.status(500).json({ success: false, message: error.message || 'Internal Server Error' });
    }
  };

function parseBody<T extends z.ZodTypeAny>(schema: T, body: any): z.infer<T> {
  return schema.parse(body) as z.infer<T>;
}

const userOf = (req: AuthenticatedRequest) => ({
  userId: req.user?.userId,
  email: req.user?.email || 'SYSTEM',
});

/* ─── Items ────────────────────────────────────────────────────────────────── */

export const getItems = h(async (req, res) => {
  const { search, itemType, categoryId, supplierId, isActive, priceStatus, sort, order, page, limit } = req.query;
  const data = await service.listItems({
    search: search as string,
    itemType: itemType as string,
    categoryId: categoryId as string,
    supplierId: supplierId as string,
    isActive: isActive as string,
    priceStatus: priceStatus as string,
    sort: sort as string,
    order: order as string,
    page: page as string,
    limit: limit as string,
  });
  return res.json({ success: true, data: data.items, meta: data.meta });
});

export const getNextCode = h(async (req, res) => {
  const data = await service.nextCode(String(req.query.itemType || 'COMPONENT'));
  return res.json({ success: true, data });
});

export const getItem = h(async (req, res) => {
  const data = await service.getItemDetail(req.params.id);
  return res.json({ success: true, data });
});

export const postItem = h(async (req, res) => {
  const input = parseBody(createItemSchema, req.body);
  const data = await service.createItem(input, userOf(req));
  return res.status(201).json({ success: true, message: 'Item created successfully', data });
});

export const patchItem = h(async (req, res) => {
  const input = parseBody(updateItemSchema, req.body);
  const data = await service.updateItem(req.params.id, input, userOf(req));
  return res.json({ success: true, message: 'Item updated successfully', data });
});

export const deleteItem = h(async (req, res) => {
  const data = await service.deactivateItem(req.params.id, userOf(req));
  return res.json({ success: true, message: 'Item deactivated successfully', data });
});

/* ─── Prices ───────────────────────────────────────────────────────────────── */

export const getItemPrices = h(async (req, res) => {
  const page = parseInt(String(req.query.page || '1'), 10) || 1;
  const limit = parseInt(String(req.query.limit || '50'), 10) || 50;
  const data = await service.getPriceVersions(req.params.id, page, limit);
  return res.json({ success: true, data: data.versions, meta: data.meta });
});

export const postItemPrice = h(async (req, res) => {
  const input = parseBody(createPriceSchema, req.body);
  const data = await service.createPriceVersion(req.params.id, input, userOf(req));
  return res.status(201).json({ success: true, message: 'New price version created', data });
});

export const getItemHistory = h(async (req, res) => {
  const data = await service.getItemDetail(req.params.id);
  return res.json({ success: true, data: data.priceVersions, meta: data.priceVersionsMeta });
});

/* ─── Costing ──────────────────────────────────────────────────────────────── */

export const getItemCosts = h(async (req, res) => {
  const page = parseInt(String(req.query.page || '1'), 10) || 1;
  const limit = parseInt(String(req.query.limit || '50'), 10) || 50;
  const data = await service.getCostVersions(req.params.id, page, limit);
  return res.json({ success: true, data: data.versions, meta: data.meta });
});

export const postItemCost = h(async (req, res) => {
  const input = parseBody(createCostSchema, req.body);
  const data = await service.createCostVersion(req.params.id, input, userOf(req));
  return res.status(201).json({ success: true, message: 'New cost version created', data });
});

/* ─── Rules ────────────────────────────────────────────────────────────────── */

export const getRules = h(async (req, res) => {
  const { isActive, appliesTo, search } = req.query;
  const data = await service.listRules({
    isActive: isActive as string,
    appliesTo: appliesTo as string,
    search: search as string,
  });
  return res.json({ success: true, data });
});

export const postRule = h(async (req, res) => {
  const input = parseBody(createRuleSchema, req.body);
  const data = await service.createRule(input, userOf(req));
  return res.status(201).json({ success: true, message: 'Markup rule created', data });
});

export const patchRule = h(async (req, res) => {
  const input = parseBody(updateRuleSchema, req.body);
  const data = await service.updateRule(req.params.id, input, userOf(req));
  return res.json({ success: true, message: 'Markup rule updated', data });
});

/* ─── Calculation / dashboard / history / meta / lookup ────────────────────── */

export const postCalculate = h(async (req, res) => {
  const input = parseBody(calculateSchema, req.body);
  const data = await service.calculate(input);
  return res.json({ success: true, data });
});

export const getDashboard = h(async (_req, res) => {
  const data = await service.dashboard();
  return res.json({ success: true, data });
});

export const getHistory = h(async (req, res) => {
  const { from, to, search, categoryId, user, page, limit } = req.query;
  const data = await service.history({
    from: from as string,
    to: to as string,
    search: search as string,
    categoryId: categoryId as string,
    user: user as string,
    page: page as string,
    limit: limit as string,
  });
  return res.json({ success: true, data: data.rows, meta: data.meta });
});

export const getMeta = h(async (_req, res) => {
  const data = await service.meta();
  return res.json({ success: true, data });
});

export const getLookup = h(async (_req, res) => {
  const data = await service.lookup();
  return res.json({ success: true, data });
});

/* ─── Export ───────────────────────────────────────────────────────────────── */

export const getExport = h(async (_req, res) => {
  const csv = await service.exportCsv();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="pricing_items_${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.send(csv);
});

/* ─── Import ───────────────────────────────────────────────────────────────── */

export const postImportPreview = h(async (req, res) => {
  const input = parseBody(importPreviewSchema, req.body);
  const data = await service.importPreview(input.rows);
  return res.json({ success: true, data });
});

export const postImportCommit = h(async (req, res) => {
  const input = parseBody(importCommitSchema, req.body);
  const data = await service.importCommit(input.rows, userOf(req));
  return res.json({ success: true, message: 'Import completed', data });
});
