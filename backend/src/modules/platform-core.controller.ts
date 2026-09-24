import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Param, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min, MinLength } from 'class-validator';
import { Request, Response } from 'express';
import { ErrorCode } from '../common/errors';
import { csrfCookieName } from '../common/crypto';
import { AuthenticatedPrincipal, PlatformCoreService } from './platform-core.service';
import { WorkflowStatus, WORKFLOW_STATUSES } from './workflow/workflow-transitions';

class LoginDto {
  @ApiProperty({ example: 'STAFF', enum: ['STAFF', 'CUSTOMER', 'AGENCY', 'WORKLOAD'] })
  @IsIn(['STAFF', 'CUSTOMER', 'AGENCY', 'WORKLOAD'])
  realm!: 'STAFF' | 'CUSTOMER' | 'AGENCY' | 'WORKLOAD';

  @ApiProperty({ example: 'admin' })
  @IsString()
  @MinLength(1)
  username!: string;

  @ApiProperty({ example: 'change-me' })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({ example: '123456', required: false })
  @IsOptional()
  @IsString()
  @MinLength(6)
  totp?: string;
}

class RegisterPanelDto {
  @ApiProperty({ example: 'crew' })
  @IsString()
  @MinLength(2)
  code!: string;

  @ApiProperty({ example: 'crew-service' })
  @IsString()
  ownerService!: string;

  @ApiProperty({ example: 'INTERNAL' })
  @IsString()
  classification!: string;

  @ApiProperty({ example: 'خدمه' })
  @IsString()
  titleFa!: string;

  @ApiProperty({ example: 'Crew' })
  @IsString()
  titleEn!: string;

  @ApiProperty({ example: 'panel:crew' })
  @IsString()
  audience!: string;
}

class GrantEntitlementDto {
  @ApiProperty({ example: '5c1b0b3e-3c1d-4c2a-9c2a-111111111111' })
  @IsUUID()
  principalId!: string;

  @ApiProperty({ example: 'crew' })
  @IsString()
  panelCode!: string;
}

class GatewayDecisionDto {
  @ApiProperty({ example: 'GET' })
  @IsString()
  method!: string;

  @ApiProperty({ example: '/v1/flights/{id}/operations' })
  @IsString()
  pathPattern!: string;
}

class StartWorkflowDto {
  @ApiProperty({ example: 'commerce.order.v1' })
  @IsString()
  definitionKey!: string;

  @ApiProperty({ example: 'commerce' })
  @IsString()
  ownerService!: string;

  @ApiProperty({ example: 'corr-1' })
  @IsString()
  correlationId!: string;
}

class TransitionWorkflowDto {
  @ApiProperty({ example: 'RUNNING', enum: WORKFLOW_STATUSES })
  @IsIn(WORKFLOW_STATUSES)
  to!: WorkflowStatus;
}

class ConsentDto {
  @ApiProperty({ example: 'ANALYTICS', enum: ['ANALYTICS', 'ADVERTISING'] })
  @IsIn(['ANALYTICS', 'ADVERTISING'])
  purpose!: 'ANALYTICS' | 'ADVERTISING';

  @ApiProperty({ example: '2026-09-01' })
  @IsString()
  policyVersion!: string;

  @ApiProperty({ example: 'GRANTED', enum: ['GRANTED', 'WITHDRAWN'] })
  @IsIn(['GRANTED', 'WITHDRAWN'])
  decision!: 'GRANTED' | 'WITHDRAWN';
}

class RegisterRouteDto {
  @ApiProperty({ example: 'GET' })
  @IsString()
  method!: string;

  @ApiProperty({ example: '/v1/flights/{id}/operations' })
  @IsString()
  pathPattern!: string;

  @ApiProperty({ example: 'http://flight-ops.internal' })
  @IsString()
  upstreamBaseUrl!: string;

  @ApiProperty({ example: 'panel:flight-ops' })
  @IsString()
  audience!: string;

  @ApiProperty({ example: 200 })
  @IsInt()
  @Min(50)
  @Max(5000)
  timeoutMs!: number;

  @ApiProperty({ example: 'STAFF' })
  @IsString()
  allowedRealms!: string;

  @ApiProperty({ example: 'v1' })
  @IsString()
  version!: string;
}

type AuthedRequest = Request & { principal?: AuthenticatedPrincipal; id?: string };

@ApiTags('platform-core')
@Controller()
export class PlatformCoreController {
  constructor(private readonly core: PlatformCoreService) {}

  @Post('v1/sessions')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'ورود و صدور کوکی نشست میزبان' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const opened = await this.core.login(dto);
    this.writeCookies(res, opened.sessionToken, opened.csrfToken);
    return { success: true, data: { principalId: opened.principal.id, realm: opened.principal.realm, csrfToken: opened.csrfToken } };
  }

  @Post('v1/sessions/logout')
  @ApiOperation({ summary: 'خروج و ابطال نشست' })
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const actor = await this.actor(req);
    const token = this.sessionToken(req);
    await this.core.assertCsrf(token, this.csrfHeader(req));
    await this.core.logout(token, actor.id, this.correlation(req));
    this.clearCookies(res);
    return { success: true, data: { revoked: true } };
  }

  @Post('v1/sessions/rotate')
  @ApiOperation({ summary: 'چرخش نشست پس از ورود یا تغییر امتیاز' })
  async rotate(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const actor = await this.actor(req);
    const token = this.sessionToken(req);
    await this.core.assertCsrf(token, this.csrfHeader(req));
    const opened = await this.core.rotate(token, actor.id, this.correlation(req));
    this.writeCookies(res, opened.sessionToken, opened.csrfToken);
    return { success: true, data: { rotated: true, csrfToken: opened.csrfToken } };
  }

  @Get('v1/panels')
  @ApiOperation({ summary: 'فهرست پنل‌های مجاز کاربر' })
  async listPanels(@Req() req: AuthedRequest) {
    const actor = await this.actor(req);
    const panels = await this.core.listEntitledPanels(actor);
    return {
      success: true,
      data: panels.map((panel) => ({
        code: panel.code,
        titleFa: panel.titleFa,
        titleEn: panel.titleEn,
        audience: panel.audience,
        ownerService: panel.ownerService,
      })),
    };
  }

  @Post('v1/panels')
  @ApiOperation({ summary: 'ثبت پنل در رجیستری سکو' })
  async registerPanel(
    @Req() req: AuthedRequest,
    @Body() dto: RegisterPanelDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const actor = await this.requireMutation(req);
    if (!idempotencyKey) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION, message: 'کلید تکرار الزامی است.' });
    }
    const panel = await this.core.registerPanel(actor, dto, idempotencyKey, this.correlation(req));
    return { success: true, data: { id: panel.id, code: panel.code, audience: panel.audience } };
  }

  @Post('v1/entitlements')
  @ApiOperation({ summary: 'اعطای دسترسی پنل توسط مدیر دیگر' })
  async grant(@Req() req: AuthedRequest, @Body() dto: GrantEntitlementDto) {
    const actor = await this.requireMutation(req);
    const entitlement = await this.core.grantEntitlement(actor, dto, this.correlation(req));
    return { success: true, data: { id: entitlement.id, status: entitlement.status } };
  }

  @Post('v1/panels/:code/access-tokens')
  @ApiOperation({ summary: 'صدور توکن کوتاه‌عمر با مخاطب همان پنل' })
  async issueToken(@Req() req: AuthedRequest, @Param('code') code: string) {
    const actor = await this.requireMutation(req);
    const data = await this.core.issuePanelToken(actor, code);
    return { success: true, data };
  }

  @Post('v1/gateway/routes')
  @ApiOperation({ summary: 'ثبت قرارداد مسیر درگاه' })
  async registerRoute(@Req() req: AuthedRequest, @Body() dto: RegisterRouteDto) {
    const actor = await this.requireMutation(req);
    if (actor.role !== 'PLATFORM_ADMIN' || actor.realm !== 'STAFF') {
      throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'این عملیات فقط برای مدیر سکو مجاز است.' });
    }
    const route = await this.core.registerRoute({
      ...dto,
      allowedRealms: dto.allowedRealms.split(',').map((item) => item.trim()),
    });
    return { success: true, data: { id: route.id, audience: route.audience, timeoutMs: route.timeoutMs } };
  }

  @Post('v1/gateway/decisions')
  @ApiOperation({ summary: 'تصمیم مجوز مسیر بر اساس مخاطب توکن' })
  async decide(@Req() req: Request, @Body() dto: GatewayDecisionDto) {
    const data = await this.core.decideRoute(req.header('authorization'), dto.method, dto.pathPattern);
    return { success: true, data };
  }

  @Post('v1/gateway/routes/:id/probe')
  @ApiOperation({ summary: 'سنجش مهلت سرویس بالادست بدون ذخیره پاسخ کسب‌وکار' })
  async probe(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.requireMutation(req);
    const data = await this.core.probeUpstream(id);
    return { success: true, data };
  }

  @Post('v1/workflow-runs')
  @ApiOperation({ summary: 'شروع اجرای موتور گردش‌کار بدون ذخیره تصمیم کسب‌وکار' })
  async startWorkflow(
    @Req() req: AuthedRequest,
    @Body() dto: StartWorkflowDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const actor = await this.requireMutation(req);
    if (!idempotencyKey) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION, message: 'کلید تکرار الزامی است.' });
    }
    const run = await this.core.startWorkflow(actor, dto, idempotencyKey);
    return { success: true, data: { id: run.id, status: run.status, ownerService: run.ownerService } };
  }

  @Post('v1/workflow-runs/:id/transitions')
  @ApiOperation({ summary: 'تغییر وضعیت موتور گردش‌کار' })
  async transition(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: TransitionWorkflowDto) {
    const actor = await this.requireMutation(req);
    const run = await this.core.transitionWorkflow(actor, id, dto.to, this.correlation(req));
    return { success: true, data: { id: run.id, status: run.status } };
  }

  @Post('v1/consents')
  @ApiOperation({ summary: 'ثبت رضایت یا انصراف از کوکی اختیاری' })
  async consent(@Req() req: AuthedRequest, @Body() dto: ConsentDto) {
    const actor = await this.requireMutation(req);
    const record = await this.core.recordConsent(actor, dto, this.correlation(req));
    return { success: true, data: { id: record.id, purpose: record.purpose, decision: record.decision } };
  }

  @Get('v1/consents/me')
  @ApiOperation({ summary: 'وضعیت رضایت اختیاری کاربر' })
  async myConsent(@Req() req: AuthedRequest) {
    const actor = await this.actor(req);
    const data = await this.core.consentSnapshot(actor);
    return { success: true, data };
  }

  @Get('v1/audit-events')
  @ApiOperation({ summary: 'خواندن رویدادهای ممیزی سکو' })
  async audit(@Req() req: AuthedRequest) {
    const actor = await this.actor(req);
    const rows = await this.core.listAudit(actor);
    return {
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        action: row.action,
        objectType: row.objectType,
        objectId: row.objectId,
        correlationId: row.correlationId,
      })),
    };
  }

  private async actor(req: AuthedRequest): Promise<AuthenticatedPrincipal> {
    const token = this.sessionToken(req);
    return this.core.authenticate(token);
  }

  private async requireMutation(req: AuthedRequest): Promise<AuthenticatedPrincipal> {
    this.assertOrigin(req);
    const token = this.sessionToken(req);
    await this.core.assertCsrf(token, this.csrfHeader(req));
    return this.core.authenticate(token);
  }

  private sessionToken(req: Request): string {
    const policy = this.core.sessionPolicy();
    const token = req.cookies?.[policy.name] as string | undefined;
    if (!token) {
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHENTICATED, message: 'نشست معتبر نیست.' });
    }
    return token;
  }

  private csrfHeader(req: Request): string | undefined {
    const value = req.header('x-csrf-token');
    return value;
  }

  private assertOrigin(req: Request): void {
    const origin = req.header('origin');
    const allowed = (req.app.get('allowedOrigins') as string[] | undefined) ?? [];
    if (!origin || !allowed.includes(origin)) {
      throw new UnauthorizedException({ code: ErrorCode.CSRF_REJECTED, message: 'مبدأ درخواست پذیرفته نیست.' });
    }
  }

  private correlation(req: AuthedRequest): string {
    return req.id ?? req.header('x-request-id') ?? 'missing-correlation';
  }

  private writeCookies(res: Response, sessionToken: string, csrfToken: string): void {
    const policy = this.core.sessionPolicy();
    res.cookie(policy.name, sessionToken, {
      httpOnly: true,
      secure: policy.secure,
      sameSite: 'lax',
      path: '/',
    });
    res.cookie(csrfCookieName(policy.secure), csrfToken, {
      httpOnly: false,
      secure: policy.secure,
      sameSite: 'lax',
      path: '/',
    });
  }

  private clearCookies(res: Response): void {
    const policy = this.core.sessionPolicy();
    res.clearCookie(policy.name, { path: '/' });
    res.clearCookie(csrfCookieName(policy.secure), { path: '/' });
  }
}
