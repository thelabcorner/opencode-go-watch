const PAID_BASE = 2_000_000;
const FREE_BASE = 3_000_000;
const QUOTA_EXEMPT_BASE = 4_000_000;

/**
 * Convert V2 semantics into one presentation-only ordering score.
 *
 * This does not create new economic ranks. Paid ranks come directly from the
 * Usage Yield V2 leaderboard. Free states are only grouped ahead of paid models
 * according to the V2 monetary-tier hierarchy; models within an unrankable free
 * tier remain alphabetic rather than receiving invented ordinal ranks.
 */
export function usageValuePresentationScore({ rank = null, free = false, quotaExempt = false } = {}) {
  if (quotaExempt) return QUOTA_EXEMPT_BASE;
  if (free) return FREE_BASE;
  if (Number.isFinite(rank) && rank > 0) return PAID_BASE - rank;
  return 0;
}

export const usageValueRankScript = String.raw`(()=>{
  const norm=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const paidRanks=new Map();
  const valueRows=[...document.querySelectorAll('#usage-value tbody tr')];
  for(const row of valueRows){
    const cells=row.querySelectorAll('td');
    if(cells.length<2)continue;
    const rankMatch=String(cells[0].textContent||'').match(/#\s*(\d+)/);
    const model=cells[1].querySelector('strong')?.textContent||cells[1].textContent;
    const rank=rankMatch?Number(rankMatch[1]):NaN;
    if(model&&Number.isFinite(rank))paidRanks.set(norm(model),rank);
  }

  const modelName=row=>row.querySelector('.model strong')?.textContent?.trim()||'';
  const isZen=location.pathname==='/zen'||location.pathname==='/zen/';
  const tierFor=row=>{
    if(isZen){
      const status=row.querySelector('td[data-label="Status"]')?.textContent||'';
      return /\bFREE\b/i.test(status)?'free':'paid';
    }
    const five=row.querySelector('td[data-label="5h requests"]')?.textContent||'';
    if(/[∞]|quota[- ]?exempt/i.test(five))return'quota';
    const priceLabels=['Input','Output','Cached read'];
    const priceText=priceLabels.map(label=>row.querySelector('td[data-label="'+label+'"]')?.textContent||'').join(' ');
    return /\bFree\b/i.test(priceText)?'free':'paid';
  };
  const scoreFor=(row,name)=>{
    const tier=tierFor(row);
    if(tier==='quota')return 4000000;
    if(tier==='free')return 3000000;
    const rank=paidRanks.get(norm(name));
    return Number.isFinite(rank)?2000000-rank:0;
  };
  const labelFor=(row,name)=>{
    const tier=tierFor(row);
    if(tier==='quota')return'V2 · quota-exempt';
    if(tier==='free')return'V2 · free';
    const rank=paidRanks.get(norm(name));
    return Number.isFinite(rank)?'V2 #'+rank:'V2 · unranked';
  };
  const byScoreThenName=(a,b)=>Number(b.dataset.sortV2||0)-Number(a.dataset.sortV2||0)||modelName(a).localeCompare(modelName(b));

  const tableBody=document.querySelector('#models #rows');
  if(tableBody){
    const rows=[...tableBody.querySelectorAll(':scope > tr')];
    for(const row of rows){
      const name=modelName(row);
      row.dataset.sortV2=String(scoreFor(row,name));
      const strong=row.querySelector('.model strong');
      if(strong&&!strong.parentElement.querySelector('[data-v2-rank-badge]')){
        const badge=document.createElement('span');
        badge.dataset.v2RankBadge='';
        badge.className=isZen?'badge v':'pill';
        badge.textContent=labelFor(row,name);
        badge.style.marginLeft='6px';
        strong.insertAdjacentElement('afterend',badge);
      }
    }
    rows.sort(byScoreThenName).forEach(row=>tableBody.appendChild(row));
  }

  if(!isZen){
    const scoreByName=new Map();
    for(const row of document.querySelectorAll('#models #rows > tr'))scoreByName.set(norm(modelName(row)),Number(row.dataset.sortV2||0));
    const bars=document.querySelector('#chart .bars');
    if(bars){
      const entries=[...bars.querySelectorAll(':scope > .bar-entry')];
      for(const entry of entries){
        const name=entry.querySelector('.barname > span:last-child')?.textContent?.trim()||'';
        entry.dataset.sortV2=String(scoreByName.get(norm(name))||0);
      }
      entries.sort((a,b)=>Number(b.dataset.sortV2||0)-Number(a.dataset.sortV2||0)||String(a.querySelector('.barname > span:last-child')?.textContent||'').localeCompare(String(b.querySelector('.barname > span:last-child')?.textContent||''))).forEach(entry=>bars.insertBefore(entry,bars.querySelector('.legend')));
    }

    const sort=document.querySelector('#sort');
    if(sort){
      if(!sort.querySelector('option[value="v2"]')){
        const option=document.createElement('option');
        option.value='v2';
        option.textContent='Usage value V2 rank';
        sort.insertBefore(option,sort.firstChild);
      }
      sort.value='v2';
      sort.dispatchEvent(new Event('change',{bubbles:true}));
    }
  }
})();`;
