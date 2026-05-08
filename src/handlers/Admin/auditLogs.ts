import { Request, Response } from 'express';
import mongoose from 'mongoose';
import AuditLog from '../../models/auditLog';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const listAuditLogs = async (req: Request, res: Response) => {
  try {
    const {
      action,
      actor,
      actorEmail,
      targetType,
      targetId,
      status,
      from,
      until,
      page,
      limit,
    } = req.query;

    const pageNumber = Math.max(Math.floor(Number(page) || 1), 1);
    const limitNumber = Math.min(Math.max(Math.floor(Number(limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
    const skip = (pageNumber - 1) * limitNumber;

    const query: Record<string, any> = {};

    if (typeof action === 'string' && action.trim()) {
      query.action = action.trim();
    }

    if (typeof actor === 'string' && mongoose.Types.ObjectId.isValid(actor)) {
      query.actor = new mongoose.Types.ObjectId(actor);
    }

    if (typeof actorEmail === 'string' && actorEmail.trim().length >= 2) {
      query.actorEmail = new RegExp(escapeRegex(actorEmail.trim().toLowerCase()), 'i');
    }

    if (typeof targetType === 'string' && targetType.trim()) {
      query.targetType = targetType.trim();
    }

    if (typeof targetId === 'string' && mongoose.Types.ObjectId.isValid(targetId)) {
      query.targetId = new mongoose.Types.ObjectId(targetId);
    }

    if (typeof status === 'string' && (status === 'success' || status === 'failure')) {
      query.status = status;
    }

    const fromDate = parseDate(from);
    const untilDate = parseDate(until);
    if (
      untilDate &&
      untilDate.getUTCHours() === 0 &&
      untilDate.getUTCMinutes() === 0 &&
      untilDate.getUTCSeconds() === 0 &&
      untilDate.getUTCMilliseconds() === 0
    ) {
      untilDate.setUTCHours(23, 59, 59, 999);
    }
    if (fromDate || untilDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = fromDate;
      if (untilDate) query.createdAt.$lte = untilDate;
    }

    const [logs, totalCount] = await Promise.all([
      AuditLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),
      AuditLog.countDocuments(query),
    ]);

    return res.json({
      success: true,
      data: {
        logs,
        pagination: {
          page: pageNumber,
          limit: limitNumber,
          total: totalCount,
          totalPages: Math.max(1, Math.ceil(totalCount / limitNumber)),
        },
      },
    });
  } catch (error: any) {
    console.error('[ADMIN][AUDIT_LOGS] Failed to list logs', error);
    return res.status(500).json({
      success: false,
      msg: error?.message || 'Failed to load audit logs',
    });
  }
};

export const getAuditLogStats = async (req: Request, res: Response) => {
  try {
    const { from, until, action, targetType, status } = req.query;

    const query: Record<string, any> = {};
    if (typeof action === 'string' && action.trim()) query.action = action.trim();
    if (typeof targetType === 'string' && targetType.trim()) query.targetType = targetType.trim();
    if (typeof status === 'string' && (status === 'success' || status === 'failure')) query.status = status;

    const fromDate = parseDate(from);
    const untilDate = parseDate(until);
    if (
      untilDate &&
      untilDate.getUTCHours() === 0 &&
      untilDate.getUTCMinutes() === 0 &&
      untilDate.getUTCSeconds() === 0 &&
      untilDate.getUTCMilliseconds() === 0
    ) {
      untilDate.setUTCHours(23, 59, 59, 999);
    }
    if (fromDate || untilDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = fromDate;
      if (untilDate) query.createdAt.$lte = untilDate;
    }

    const [total, failures, uniqueActors] = await Promise.all([
      AuditLog.countDocuments(query),
      AuditLog.countDocuments({ ...query, status: 'failure' }),
      AuditLog.distinct('actor', query),
    ]);

    return res.json({
      success: true,
      data: {
        total,
        failures,
        uniqueActors: uniqueActors.filter(Boolean).length,
      },
    });
  } catch (error: any) {
    console.error('[ADMIN][AUDIT_LOGS][STATS] Failed', error);
    return res.status(500).json({ success: false, msg: error?.message || 'Failed to load audit stats' });
  }
};
