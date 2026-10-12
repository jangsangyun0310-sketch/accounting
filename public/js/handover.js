// 인수인계용 전체 Excel: /api/export/all 자료를 시트 여러 장으로 (설정 → 백업·계정 → 백업)
// 프로그램 없이 Excel 만으로 기록을 볼 수 있게 — 금액은 숫자 칸, 날짜는 2026-10-11 글자
import { APPROVAL_DOC_LABEL } from './shared/approval-docs.js';

const b = (v) => ({ v, bold: true });
// 거래 구분 (화면의 typeLabel 과 같음 — 이 파일은 화면 없이도 쓰여서 따로 둔다)
const typeLabel = (t) => (t.kind === 'TRANSFER' ? (t.direction === 'OUT' ? '이체출금' : '이체입금')
  : t.deduction ? '수입차감' : t.direction === 'IN' ? '수입' : '지출');
const MASS_KIND = { SUNDAY: '주일', WEEKDAY: '평일', WEDDING: '혼배', FUNERAL: '장례', SPECIAL: '특별' };
const DOC_DIR = { '': '', IN: '수신', OUT: '발신' };
const SACRAMENTS = [['baptism', '세례'], ['confirmation', '견진'], ['anointing', '병자'], ['marriage', '혼인'], ['funeral', '장례'], ['communion', '봉성체']];

export function handoverSheets(d) {
  const sheets = [];

  sheets.push({
    name: '안내',
    widths: [18, 70],
    rows: [
      [b(`${d.parishName} 회계 · 사목일지 전체 기록`)],
      [],
      ['성당', d.parishName],
      ['기간', `${d.from} ~ ${d.to}`],
      ['만든 날', d.to],
      ['작성자', d.writerName],
      [],
      [b('시트'), b('내용')],
      ['거래 내역', '모든 수입 · 지출 · 이체 (수입차감은 입금 칸에 마이너스)'],
      ['월별 결산', '달마다 회계별 이월 · 수입 · 지출 · 이체 · 잔액'],
      ...d.bySubject.map((y) => [`과목별 ${y.year}`, `${y.year}년 수입 · 지출 과목별 달마다 합계`]),
      ['통장 · 현금', `통장과 현금의 정보와 ${d.to} 잔액`],
      ['사목일지', '날짜별 신자 현황 · 미사 · 성사 · 공문서 · 특이사항'],
      ['개인별 납부', '특별회계 수입 중 납부자를 적은 것 (연말정산용)'],
      ['설정', '예산과목 · 결재선'],
      [],
      ['참고', '본당살림 프로그램에서 내려받은 파일입니다. 이 파일만으로 기록을 볼 수 있습니다.'],
    ],
  });

  sheets.push({
    name: '거래 내역',
    header: 1,
    widths: [12, 10, 10, 18, 20, 32, 16, 14, 14, 26],
    rows: [
      ['날짜', '구분', '회계', '통장', '과목 · 상대통장', '적요', '납부자', '입금', '출금', '입력자'].map(b),
      ...d.transactions.map((t) => {
        const isIn = t.direction === 'IN';
        return [
          t.date, typeLabel(t), t.fundCode === 'GENERAL' ? '일반회계' : '특별회계', t.accountName,
          t.kind === 'TRANSFER' ? `${isIn ? '←' : '→'} ${t.counterpartName ?? ''}` : (t.subjectName ?? ''),
          t.memo ?? '', t.payer ?? '',
          isIn ? t.amount : t.deduction ? -t.amount : null,
          isIn || t.deduction ? null : t.amount,
          t.createdBy ?? '',
        ];
      }),
    ],
  });

  const fundRow = (month, name, f) => [month, name, f.prev, f.income, f.expense, f.transferIn - f.transferOut, f.end];
  sheets.push({
    name: '월별 결산',
    header: 1,
    widths: [10, 12, 16, 16, 16, 14, 16],
    rows: [
      ['월', '회계', '전월이월', '수입', '지출', '이체(±)', '월말잔액'].map(b),
      ...d.monthly.flatMap((m) => [
        ...m.funds.map((f) => fundRow(m.month, f.name, f)),
        fundRow(m.month, '합계', m.total).map((v) => (v == null ? v : b(v))),
      ]),
    ],
  });

  for (const y of d.bySubject) {
    const part = (label, rows) => {
      const names = Object.keys(rows);
      const sum = (name) => Object.values(rows[name]).reduce((a, n) => a + n, 0);
      return [
        [b(label)],
        ...names.map((name) => [name, ...Array.from({ length: 12 }, (_, i) => rows[name][i + 1] ?? null), sum(name)]),
        [b(`${label} 합계`), ...Array.from({ length: 12 }, (_, i) => b(names.reduce((a, n) => a + (rows[n][i + 1] ?? 0), 0))),
          b(names.reduce((a, n) => a + sum(n), 0))],
        [],
      ];
    };
    sheets.push({
      name: `과목별 ${y.year}`,
      header: 1,
      widths: [20, ...Array(12).fill(12), 14],
      rows: [
        ['과목', ...Array.from({ length: 12 }, (_, i) => `${i + 1}월`), '합계'].map(b),
        ...part('수입', y.income),
        ...part('지출', y.expense),
      ],
    });
  }

  sheets.push({
    name: '통장 · 현금',
    header: 1,
    widths: [10, 20, 8, 12, 22, 10, 16],
    rows: [
      ['회계', '이름', '종류', '은행', '계좌번호', '상태', `잔액 (${d.to})`].map(b),
      ...d.accounts.map((a) => [a.fund, a.name, a.isCash ? '현금' : '통장', a.bank, a.accountNo, a.isActive ? '사용' : '사용중지', a.balance]),
      [b('합계'), null, null, null, null, null, b(d.accounts.reduce((n, a) => n + a.balance, 0))],
    ],
  });

  const massesOf = new Map();
  for (const m of d.masses) {
    if (!massesOf.has(m.journal_date)) massesOf.set(m.journal_date, []);
    massesOf.get(m.journal_date).push(m);
  }
  const docsOf = new Map();
  for (const x of d.documents) {
    if (!docsOf.has(x.journal_date)) docsOf.set(x.journal_date, []);
    docsOf.get(x.journal_date).push(x);
  }
  sheets.push({
    name: '사목일지',
    header: 1,
    widths: [12, 8, 8, 10, 8, 8, 10, 44, 10, 10, ...SACRAMENTS.map(() => 7), 40, 50],
    rows: [
      ['날짜', '세대 전입', '세대 전출', '세대 총원', '인원 전입', '인원 전출', '인원 총원', '미사 (시간 이름 구분 참석/고해)',
        '미사 참석', '고해성사', ...SACRAMENTS.map(([, l]) => l), '공문서 수발신', '특이사항'].map(b),
      ...d.journals.map((j) => {
        const ms = massesOf.get(j.journal_date) ?? [];
        return [
          j.journal_date, j.households_in, j.households_out, j.households_total, j.members_in, j.members_out, j.members_total,
          ms.map((m) => `${m.mass_time} ${m.name} (${MASS_KIND[m.kind]}) ${m.attendance}/${m.confessions}`).join('; '),
          ms.reduce((n, m) => n + m.attendance, 0), ms.reduce((n, m) => n + m.confessions, 0),
          ...SACRAMENTS.map(([k]) => j[k]),
          (docsOf.get(j.journal_date) ?? []).map((x) => [DOC_DIR[x.direction], x.doc_no, x.party, x.title].filter(Boolean).join(' · ')).join('; '),
          j.notes,
        ];
      }),
    ],
  });

  sheets.push({
    name: '개인별 납부',
    header: 1,
    widths: [8, 22, 12, 20, 14],
    rows: [
      ['연도', '납부자', '납입 날짜', '헌금 종류', '금액'].map(b),
      ...d.donors.map((x) => [x.tx_date.slice(0, 4), x.payer, x.tx_date, x.subject_name ?? '', x.amount]),
    ],
  });

  sheets.push({
    name: '비품대장',
    header: 1,
    widths: [11, 22, 22, 7, 12, 14, 16, 16, 12, 34],
    rows: [
      ['관리번호', '품명', '규격·모델', '수량', '구매일자', '구매금액', '구매처', '둘 곳', '폐기일자', '비고'].map(b),
      ...(d.equipment ?? []).map((x) => [x.item_no, x.name, x.spec, x.quantity, x.purchase_date, x.price, x.vendor, x.location, x.disposed_at ?? '',
        [x.deleted_at ? `삭제 ${x.deleted_at}${x.delete_reason ? ` · ${x.delete_reason}` : ''}` : x.dispose_reason, x.note].filter(Boolean).join(' / ')]),
    ],
  });

  sheets.push({
    name: '설정',
    widths: [10, 24, 10, 14],
    rows: [
      [b('예산과목')],
      ['구분', '과목', '상태', '차감(−) 허용'].map(b),
      ...d.subjects.map((s) => [s.kind === 'INCOME' ? '수입' : '지출', s.name, s.isActive ? '사용' : '사용중지', s.allowDeduction ? '예' : '']),
      [],
      [b('결재란')],
      ...Object.entries(APPROVAL_DOC_LABEL).map(([doc, label]) => [label, (d.approval[doc] ?? []).join(' · ') || '(결재란 없음)']),
    ],
  });
  return sheets;
}
