import { BadRequestException, Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req, Res, UnauthorizedException, Delete } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Request, Response } from 'express';
import { ErrorCode } from '../common/errors';
import { csrfCookieName, randomToken } from '../common/crypto';
import { AuthenticatedPrincipal, PlatformCoreService } from './platform-core.service';
import { WorkflowStatus, WORKFLOW_STATUSES } from './workflow/workflow-transitions';
import { STEP_STATUSES, StepStatus } from './workflow/step-transitions';

class LoginDto {
  @ApiProperty({ example: 'STAFF', enum: ['STAFF', 'CUSTOMER', 'AGENCY', 'WORKLOAD'] })
  @IsIn(['STAFF', 'CUSTOMER', 'AGENCY', 'WORKLOAD'])
  realm!: 'STAFF' | 'CUSTOMER' | 'AGENCY' | 'WORKLOAD';

  @ApiProperty({ required: false, description: 'Agency tenant UUID; required for AGENCY realm' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

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
  @Matches(/^[a-z][a-z0-9-]{1,62}$/)
  code!: string;

  @ApiProperty({ example: 'crew-service' })
  @Matches(/^[a-z][a-z0-9-]{1,62}$/)
  ownerService!: string;

  @ApiProperty({ example: 'INTERNAL', enum: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] })
  @IsIn(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'])
  classification!: string;

  @ApiProperty({ example: 'خدمه' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  titleFa!: string;

  @ApiProperty({ example: 'Crew' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  titleEn!: string;

  @ApiProperty({ example: 'panel:crew' })
  @Matches(/^panel:[a-z][a-z0-9-]{1,62}$/)
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

  @ApiProperty({ example: 'v1' })
  @Matches(/^v\d+$/)
  version!: string;
}

class StartWorkflowDto {
  @ApiProperty({ example: 'commerce.order.v1' })
  @Matches(/^[a-z][a-z0-9.-]{1,120}$/)
  definitionKey!: string;

  @ApiProperty({ example: 'commerce' })
  @Matches(/^[a-z][a-z0-9-]{1,62}$/)
  ownerService!: string;

  @ApiProperty({ example: 'corr-1' })
  @Matches(/^[A-Za-z0-9._:-]{1,128}$/)
  correlationId!: string;
}

class WorkflowDefinitionStepDto {
  @Matches(/^[a-z][a-z0-9-]{1,62}$/)
  stepKey!: string;

  @IsInt()
  @Min(1)
  @Max(604800)
  timeoutSeconds!: number;
}

class RegisterWorkflowDefinitionDto {
  @Matches(/^[a-z][a-z0-9.-]{1,120}$/)
  definitionKey!: string;

  @Matches(/^[a-z][a-z0-9-]{1,62}$/)
  ownerService!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => WorkflowDefinitionStepDto)
  steps!: WorkflowDefinitionStepDto[];
}

class TransitionWorkflowDto {
  @ApiProperty({ example: 'RUNNING', enum: WORKFLOW_STATUSES })
  @IsIn(WORKFLOW_STATUSES)
  to!: WorkflowStatus;
}

class CreateWorkflowStepDto {
  @ApiProperty({ example: 'reserve-inventory' })
  @Matches(/^[a-z][a-z0-9-]{1,62}$/)
  stepKey!: string;

  @ApiProperty({ example: 300 })
  @IsInt()
  @Min(1)
  @Max(604800)
  timeoutSeconds!: number;
}

class TransitionWorkflowStepDto {
  @ApiProperty({ enum: STEP_STATUSES, example: 'RUNNING' })
  @IsIn(STEP_STATUSES)
  to!: StepStatus;
}

class ConsentDto {
  @ApiProperty({ example: 'ANALYTICS', enum: ['ANALYTICS', 'ADVERTISING'] })
  @IsIn(['ANALYTICS', 'ADVERTISING'])
  purpose!: 'ANALYTICS' | 'ADVERTISING';

  @ApiProperty({ example: '2026-09-01' })
  @Matches(/^[A-Za-z0-9._-]{1,40}$/)
  policyVersion!: string;

  @ApiProperty({ example: 'GRANTED', enum: ['GRANTED', 'WITHDRAWN'] })
  @IsIn(['GRANTED', 'WITHDRAWN'])
  decision!: 'GRANTED' | 'WITHDRAWN';
}

class AuditQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;

  @IsOptional()
  @Matches(/^[a-z][a-z0-9._-]{0,127}$/)
  action?: string;

  @IsOptional()
  @Matches(/^[A-Za-z0-9._:-]{1,128}$/)
  correlationId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
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

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

@ApiTags('platform-core')
@Controller()
export class PlatformCoreController {
  constructor(private readonly core: PlatformCoreService) {}

  @Post('v1/sessions')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'ورود و صدور کوکی نشست میزبان' })
  async login(@Req() req: Request, @Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    // Browsers always send Origin on a cross-site POST; reject login CSRF from unknown sites.
    if (req.header('origin') !== undefined) {
      this.assertOrigin(req);
    }
    const opened = await this.core.login(dto);
    this.writeCookies(res, opened.sessionToken, opened.csrfToken);
    return { success: true, data: { principalId: opened.principal.id, realm: opened.principal.realm, csrfToken: opened.csrfToken } };
  }

  @Post('v1/sessions/logout')
  @ApiOperation({ summary: 'خروج و ابطال نشست' })
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const actor = await this.requireMutation(req);
    const token = this.sessionToken(req);
    await this.core.logout(token, actor.id, this.correlation(req));
    this.clearCookies(res);
    return { success: true, data: { revoked: true } };
  }

  @Get('v1/sessions/me')
  @ApiOperation({ summary: 'هویت نشست جاری برای رابط کاربری مدیریت' })
  async currentSession(@Req() req: AuthedRequest) {
    const actor = await this.actor(req);
    return { success: true, data: { id: actor.id, username: actor.username, realm: actor.realm, role: actor.role, tenantId: actor.tenantId } };
  }

  @Post('v1/sessions/rotate')
  @ApiOperation({ summary: 'چرخش نشست پس از ورود یا تغییر امتیاز' })
  async rotate(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    const actor = await this.requireMutation(req);
    const token = this.sessionToken(req);
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
    const panel = await this.core.registerPanel(actor, dto, this.idempotencyKey(idempotencyKey), this.correlation(req));
    return { success: true, data: { id: panel.id, code: panel.code, audience: panel.audience } };
  }

  @Post('v1/entitlements')
  @ApiOperation({ summary: 'اعطای دسترسی پنل توسط مدیر دیگر' })
  async grant(@Req() req: AuthedRequest, @Body() dto: GrantEntitlementDto) {
    const actor = await this.requireMutation(req);
    const entitlement = await this.core.grantEntitlement(actor, dto, this.correlation(req));
    return { success: true, data: { id: entitlement.id, status: entitlement.status } };
  }

  @Delete('v1/entitlements/:id')
  @ApiOperation({ summary: 'لغو دسترسی پنل با ابطال فوری توکن‌های صادرشده' })
  async revoke(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const actor = await this.requireMutation(req);
    const entitlement = await this.core.revokeEntitlement(actor, id, this.correlation(req));
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
    const route = await this.core.registerRoute(
      actor,
      { ...dto, allowedRealms: dto.allowedRealms.split(',').map((item) => item.trim()) },
      this.correlation(req),
    );
    return { success: true, data: { id: route.id, audience: route.audience, timeoutMs: route.timeoutMs } };
  }

  @Post('v1/gateway/decisions')
  @ApiOperation({ summary: 'تصمیم مجوز مسیر بر اساس مخاطب توکن' })
  async decide(@Req() req: Request, @Body() dto: GatewayDecisionDto) {
    const data = await this.core.decideRoute(req.header('authorization'), dto);
    return { success: true, data };
  }

  @Get('.well-known/jwks.json')
  @ApiOperation({ summary: 'کلید عمومی امضای توکن پنل برای درگاه و سرویس‌ها' })
  jwks() {
    return this.core.panelTokenJwks();
  }

  @Post('v1/gateway/routes/:id/probe')
  @ApiOperation({ summary: 'سنجش مهلت سرویس بالادست بدون ذخیره پاسخ کسب‌وکار' })
  async probe(@Req() req: AuthedRequest, @Param('id') id: string) {
    const actor = await this.requireMutation(req);
    const data = await this.core.probeUpstream(actor, id);
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
    const run = await this.core.startWorkflow(actor, dto, this.idempotencyKey(idempotencyKey));
    return { success: true, data: { id: run.id, status: run.status, ownerService: run.ownerService } };
  }

  @Post('v1/workflow-definitions')
  @ApiOperation({ summary: 'ثبت تعریف نسخه‌دار و تغییرناپذیر گردش‌کار توسط مدیر هسته' })
  async registerWorkflowDefinition(@Req() req: AuthedRequest, @Body() dto: RegisterWorkflowDefinitionDto) {
    const actor = await this.requireMutation(req);
    const definition = await this.core.registerWorkflowDefinition(actor, dto, this.correlation(req));
    return { success: true, data: { id: definition.id, definitionKey: definition.definitionKey, ownerService: definition.ownerService } };
  }

  @Post('v1/workflow-runs/:id/transitions')
  @ApiOperation({ summary: 'تغییر وضعیت موتور گردش‌کار' })
  async transition(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: TransitionWorkflowDto) {
    const actor = await this.requireMutation(req);
    const run = await this.core.transitionWorkflow(actor, id, dto.to, this.correlation(req));
    return { success: true, data: { id: run.id, status: run.status } };
  }

  @Post('v1/workflow-runs/:id/steps')
  @ApiOperation({ summary: 'ثبت گام پایدار گردش‌کار با مهلت اجرا' })
  async createStep(
    @Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateWorkflowStepDto, @Headers('idempotency-key') key?: string,
  ) {
    const actor = await this.requireMutation(req);
    const step = await this.core.createWorkflowStep(actor, id, dto, this.idempotencyKey(key), this.correlation(req));
    return { success: true, data: step };
  }

  @Post('v1/workflow-runs/:id/steps/:stepKey/transitions')
  @ApiOperation({ summary: 'ثبت نتیجه گام یا جبران آن بدون ذخیره داده کسب‌وکار' })
  async transitionStep(
    @Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string,
    @Param('stepKey') stepKey: string, @Body() dto: TransitionWorkflowStepDto,
  ) {
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(stepKey)) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION, message: 'کلید گام نامعتبر است.' });
    }
    const actor = await this.requireMutation(req);
    const step = await this.core.transitionWorkflowStep(actor, id, stepKey, dto.to, this.correlation(req));
    return { success: true, data: { id: step.id, stepKey: step.stepKey, status: step.status } };
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

  @Post('v1/visitor-consents')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'ثبت رضایت کوکی اختیاری برای بازدیدکننده بدون ورود' })
  async visitorConsent(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response, @Body() dto: ConsentDto) {
    this.assertOrigin(req);
    const cookieName = this.core.sessionPolicy().secure ? '__Host-bj_visitor' : 'bj_visitor';
    const received = req.cookies?.[cookieName] as string | undefined;
    const token = received && /^[A-Za-z0-9_-]{40,90}$/.test(received) ? received : randomToken();
    const record = await this.core.recordVisitorConsent(token, dto, this.correlation(req));
    res.cookie(cookieName, token, {
      httpOnly: true, secure: this.core.sessionPolicy().secure, sameSite: 'lax', path: '/', maxAge: 180 * 24 * 60 * 60 * 1000,
    });
    return { success: true, data: { id: record.id, purpose: record.purpose, decision: record.decision } };
  }

  @Get('v1/visitor-consents/me')
  @ApiOperation({ summary: 'وضعیت رضایت کوکی اختیاری بازدیدکننده' })
  async visitorConsentSnapshot(@Req() req: Request) {
    const cookieName = this.core.sessionPolicy().secure ? '__Host-bj_visitor' : 'bj_visitor';
    const token = req.cookies?.[cookieName] as string | undefined;
    return { success: true, data: await this.core.visitorConsentSnapshot(token) };
  }

  @Get('v1/audit-events')
  @ApiOperation({ summary: 'خواندن رویدادهای ممیزی سکو' })
  async audit(@Req() req: AuthedRequest, @Query() filters: AuditQueryDto) {
    const actor = await this.actor(req);
    const { rows, nextCursor } = await this.core.listAudit(actor, filters);
    return {
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        action: row.action,
        objectType: row.objectType,
        objectId: row.objectId,
        correlationId: row.correlationId,
        createdAt: row.createdAt,
        actorPrincipalId: row.actorPrincipalId,
      })),
      page: { nextCursor },
    };
  }

  @Get('v1/control-plane/summary')
  @ApiOperation({ summary: 'آمار واقعی هسته بدون ادعای دادهٔ فروش سرویس‌های دامنه' })
  async controlPlaneSummary(@Req() req: AuthedRequest) {
    const actor = await this.actor(req);
    return { success: true, data: await this.core.controlPlaneSummary(actor) };
  }

  @Get('v1/outbox/dead-letters')
  @ApiOperation({ summary: 'رویدادهای متوقف‌شده پس از شکست‌های مکرر، بدون نمایش payload' })
  async deadLetters(@Req() req: AuthedRequest) {
    const actor = await this.actor(req);
    return { success: true, data: await this.core.listDeadLetters(actor) };
  }

  @Post('v1/outbox/dead-letters/:id/requeue')
  @ApiOperation({ summary: 'ارسال مجدد رویداد پس از بررسی علت شکست' })
  async requeueDeadLetter(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const actor = await this.requireMutation(req);
    const event = await this.core.requeueDeadLetter(actor, id, this.correlation(req));
    return { success: true, data: { id: event.id, eventId: event.eventId, status: 'PENDING' } };
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

  private idempotencyKey(value: string | undefined): string {
    if (!value || !IDEMPOTENCY_KEY.test(value)) {
      throw new BadRequestException({ code: ErrorCode.VALIDATION, message: 'کلید تکرار الزامی است (۸ تا ۱۲۸ نویسه).' });
    }
    return value;
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
    // __Host- cookies are only replaced (and so cleared) by a Set-Cookie that also carries Secure.
    const policy = this.core.sessionPolicy();
    res.clearCookie(policy.name, { httpOnly: true, secure: policy.secure, sameSite: 'lax', path: '/' });
    res.clearCookie(csrfCookieName(policy.secure), { httpOnly: false, secure: policy.secure, sameSite: 'lax', path: '/' });
  }
}
