import { Enquiry } from '../models/Enquiry';
import { User } from '../models/User';

export interface RFQSummary {
  totalRFQs: number;
  pendingRFQs: number;
  approvedRFQs: number;
  rejectedRFQs: number;
  recentRFQs: Array<{
    id: string;
    rfqNumber: string;
    clientName: string;
    projectType: string;
    status: string;
    createdBy: string;
    createdAt: string;
  }>;
}

export interface CostingSummary {
  totalOffersGenerated: number;
  pendingOffers: number;
  approvedOffers: number;
  totalValueINR: number;
  conversionRate: number;
  recentOffers: Array<{
    id: string;
    offerNumber: string;
    rfqNumber: string;
    clientName: string;
    amountINR: number;
    status: string;
    preparedBy: string;
    createdAt: string;
  }>;
}

export class IntegrationService {
  public static async getRFQMetrics(userScopeWhere?: any): Promise<RFQSummary> {
    try {
      const where = userScopeWhere || {};
      const allEnquiries: any[] = await Enquiry.find(where)
        .sort({ _id: -1 })
        .select('rfqId companyName itemDescription status contactPerson email dateReceived receivedOn createdAt')
        .lean();

      const totalRFQs = allEnquiries.length;

      // Exact state matching RFQ Tracker tabs:
      // 'Under review' -> Under Review tab
      // 'Approved' -> Approved tab
      // 'Offer Sent' / 'PO Received' / 'Closed' / 'REGRET'
      const pendingRFQs = allEnquiries.filter(
        (e) => (e.status || '').toLowerCase() === 'under review'
      ).length;

      const approvedRFQs = allEnquiries.filter(
        (e) => (e.status || '').toLowerCase() === 'approved'
      ).length;

      const rejectedRFQs = allEnquiries.filter(
        (e) => (e.status || '').toLowerCase() === 'regret' || (e.status || '').toLowerCase() === 'closed'
      ).length;

      const recentRFQs = allEnquiries.slice(0, 5).map((e) => ({
        id: e._id.toString(),
        rfqNumber: e.rfqId || `ENC/RFQ/#${e._id}`,
        clientName: e.companyName || 'Unnamed Customer',
        projectType: e.itemDescription || 'Heat Exchanger Requirement',
        status: e.status || 'Open',
        createdBy: e.contactPerson || e.email || 'Email Inbox',
        createdAt: e.dateReceived || e.receivedOn || new Date(e.createdAt).toISOString().split('T')[0],
      }));

      return {
        totalRFQs,
        pendingRFQs,
        approvedRFQs,
        rejectedRFQs,
        recentRFQs,
      };
    } catch (error) {
      return {
        totalRFQs: 0,
        pendingRFQs: 0,
        approvedRFQs: 0,
        rejectedRFQs: 0,
        recentRFQs: [],
      };
    }
  }

  public static async getCostingMetrics(userScopeWhere?: any): Promise<CostingSummary> {
    try {
      const where = userScopeWhere || {};
      const allEnquiries: any[] = await Enquiry.find(where)
        .sort({ _id: -1 })
        .select('rfqId companyName status offerNo offerDate assignedTo dateReceived createdAt')
        .lean();

      const enquiriesWithOffer = allEnquiries.filter((e) => (e.offerNo && e.offerNo.trim() !== '') || (e.status || '').toLowerCase() === 'offer sent');

      // Exact state matching RFQ Tracker tabs:
      // totalOffersGenerated = 'Offer Sent' status count
      // approvedOffers = 'Approved' status count
      const totalOffersGenerated = allEnquiries.filter(
        (e) => (e.status || '').toLowerCase() === 'offer sent'
      ).length;

      const pendingOffers = allEnquiries.filter(
        (e) => (e.status || '').toLowerCase() === 'under review'
      ).length;

      const approvedOffers = allEnquiries.filter(
        (e) => (e.status || '').toLowerCase() === 'approved'
      ).length;

      const conversionRate = allEnquiries.length > 0 ? Math.round((approvedOffers / allEnquiries.length) * 100) : 0;

      const recentOffers = enquiriesWithOffer.slice(0, 5).map((e) => ({
        id: e._id.toString(),
        offerNumber: e.offerNo || e.rfqId,
        rfqNumber: e.rfqId || `ENC/RFQ/#${e._id}`,
        clientName: e.companyName || 'Unnamed Customer',
        amountINR: 0,
        status: e.status || 'Offer Sent',
        preparedBy: e.assignedTo || 'Technical Team',
        createdAt: e.offerDate || e.dateReceived || new Date(e.createdAt).toISOString().split('T')[0],
      }));

      return {
        totalOffersGenerated,
        pendingOffers,
        approvedOffers,
        totalValueINR: totalOffersGenerated * 1500000,
        conversionRate,
        recentOffers,
      };
    } catch (error) {
      return {
        totalOffersGenerated: 0,
        pendingOffers: 0,
        approvedOffers: 0,
        totalValueINR: 0,
        conversionRate: 0,
        recentOffers: [],
      };
    }
  }

  public static async getEmployeeKPIs(userScopeWhere?: any, targetName?: string) {
    try {
      const where = userScopeWhere || {};
      const enquiries: any[] = await Enquiry.find(where).select('assignedTo offerNo status').lean();
      let users: any[] = await User.find().populate('roleId').lean();

      if (targetName) {
        users = users.filter((u) => u.name === targetName || u.email === targetName);
      }

      const assigneeStats = new Map<string, { rfqs: number; offers: number; approved: number; name: string; role: string }>();

      users.forEach((u) => {
        assigneeStats.set(u.name, {
          rfqs: 0,
          offers: 0,
          approved: 0,
          name: u.name,
          role: u.roleId?.description || u.roleId?.name || 'Team Member',
        });
      });

      enquiries.forEach((e) => {
        const name = e.assignedTo || 'Unassigned';
        const curr = assigneeStats.get(name) || {
          rfqs: 0,
          offers: 0,
          approved: 0,
          name,
          role: 'Assignee',
        };

        curr.rfqs += 1;
        if (e.status === 'Offer Sent') curr.offers += 1;
        if (e.status === 'Approved') curr.approved += 1;

        assigneeStats.set(name, curr);
      });

      const list = Array.from(assigneeStats.values()).map((stat) => {
        const conversionRate = stat.rfqs > 0 ? Math.round((stat.approved / stat.rfqs) * 100) : 0;
        return {
          email: `${stat.name.toLowerCase().replace(/\s+/g, '.')}@encon.co.in`,
          name: stat.name,
          role: stat.role,
          rfqsCreated: stat.rfqs,
          offersGenerated: stat.offers,
          approvedOffers: stat.approved,
          conversionRate,
          totalRevenueINR: stat.approved * 1500000,
          lastActivity: new Date().toISOString(),
        };
      });

      list.sort((a, b) => b.rfqsCreated - a.rfqsCreated);
      return list;
    } catch (error) {
      return [];
    }
  }

  public static async getMonthlyTrends(userScopeWhere?: any) {
    try {
      const where = userScopeWhere || {};
      const enquiries: any[] = await Enquiry.find(where).select('dateReceived receivedOn offerNo status').lean();

      const monthMap = new Map<string, { rfqs: number; offers: number; approved: number }>();
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

      months.forEach((m) => monthMap.set(m, { rfqs: 0, offers: 0, approved: 0 }));

      enquiries.forEach((e) => {
        const dateStr = e.dateReceived || e.receivedOn || '';
        let monthName = 'Aug';
        if (dateStr) {
          const d = new Date(dateStr);
          if (!isNaN(d.getTime())) {
            monthName = months[d.getMonth()];
          }
        }
        const curr = monthMap.get(monthName) || { rfqs: 0, offers: 0, approved: 0 };
        curr.rfqs += 1;
        if (e.status === 'Offer Sent') curr.offers += 1;
        if (e.status === 'Approved') curr.approved += 1;
        monthMap.set(monthName, curr);
      });

      return Array.from(monthMap.entries()).map(([month, data]) => ({
        month,
        rfqs: data.rfqs,
        offers: data.offers,
        approved: data.approved,
        revenue: data.approved * 1500000,
      }));
    } catch (error) {
      return [];
    }
  }
}
