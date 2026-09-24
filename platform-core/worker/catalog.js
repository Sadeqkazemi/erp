export const catalog = Object.freeze([
  ['PSS','Commerce','Inventory · Booking · Ticketing','رزرو · موجودی · صدور بلیت'],
  ['Commerce','Commerce','Search · Cart · Order','جست‌وجو · سبد · سفارش'],
  ['Payment','Commerce','Authorization · Capture · Refund','پرداخت · تسویه · استرداد'],
  ['Flight Ops','Operations','Planning · Dispatch · Flight state','برنامه‌ریزی · دیسپچ · وضعیت پرواز'],
  ['OCC','Operations','Disruption · Coordination','اختلالات · هماهنگی عملیات'],
  ['Crew','Operations','Roster · Qualification · FTL','برنامه خدمه · صلاحیت · محدودیت پرواز'],
  ['CAMO','Maintenance','Airworthiness · Engineering','صلاحیت پرواز · مهندسی'],
  ['Part 145','Maintenance','Work orders · Release','دستورکار · ترخیص فنی'],
  ['Line','Maintenance','Turnaround · Defects','گردش پرواز · نقص فنی'],
  ['Supply','Enterprise','Purchase · Inventory · Logistics','خرید · انبار · لجستیک'],
  ['Finance','Enterprise','Ledger · Reconciliation','دفتر کل · تطبیق مالی'],
  ['Site Admin','Digital','Content · Publishing','محتوا · انتشار']
].map(([name,domain,descriptionEn,descriptionFa])=>Object.freeze({id:name.toLowerCase().replaceAll(' ','-'),name,domain,descriptionEn,descriptionFa,connection:'unconfigured',health:'unknown',lastObservedAt:null})));
