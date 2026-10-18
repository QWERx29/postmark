/**
 * 国家（地区）参考库 — 中文名 / 英文名 / 二字代码
 * ================================================
 * 依赖: 无
 *
 * 「国际退信」的寄达国家（地区）三项（中文名、英文名、二字代码）同源：
 * 从候选里选一条就自动补齐另外两项，避免三个字段各填各的对不上。
 *
 * 数据以紧凑三元组维护 [二字代码, 中文名, 英文名]：
 *   - 二字代码取 ISO 3166-1 alpha-2，正好是国际邮件条码末两位用的国家代码；
 *   - 中文名按邮政/海关的通行叫法（港澳台用「中国香港 / 中国澳门 / 中国台湾」）；
 *   - 覆盖万国邮联主要寄达地，含常见属地（如 关岛 / 留尼汪 / 法属波利尼西亚）。
 *
 * 对外接口: window 作用域下的 CountryData
 */
(function () {

  const RAW = [
    ['AD', '安道尔', 'Andorra'],
    ['AE', '阿联酋', 'United Arab Emirates'],
    ['AF', '阿富汗', 'Afghanistan'],
    ['AG', '安提瓜和巴布达', 'Antigua and Barbuda'],
    ['AI', '安圭拉', 'Anguilla'],
    ['AL', '阿尔巴尼亚', 'Albania'],
    ['AM', '亚美尼亚', 'Armenia'],
    ['AO', '安哥拉', 'Angola'],
    ['AR', '阿根廷', 'Argentina'],
    ['AS', '美属萨摩亚', 'American Samoa'],
    ['AT', '奥地利', 'Austria'],
    ['AU', '澳大利亚', 'Australia'],
    ['AW', '阿鲁巴', 'Aruba'],
    ['AZ', '阿塞拜疆', 'Azerbaijan'],
    ['BA', '波黑', 'Bosnia and Herzegovina'],
    ['BB', '巴巴多斯', 'Barbados'],
    ['BD', '孟加拉国', 'Bangladesh'],
    ['BE', '比利时', 'Belgium'],
    ['BF', '布基纳法索', 'Burkina Faso'],
    ['BG', '保加利亚', 'Bulgaria'],
    ['BH', '巴林', 'Bahrain'],
    ['BI', '布隆迪', 'Burundi'],
    ['BJ', '贝宁', 'Benin'],
    ['BM', '百慕大', 'Bermuda'],
    ['BN', '文莱', 'Brunei'],
    ['BO', '玻利维亚', 'Bolivia'],
    ['BR', '巴西', 'Brazil'],
    ['BS', '巴哈马', 'Bahamas'],
    ['BT', '不丹', 'Bhutan'],
    ['BW', '博茨瓦纳', 'Botswana'],
    ['BY', '白俄罗斯', 'Belarus'],
    ['BZ', '伯利兹', 'Belize'],
    ['CA', '加拿大', 'Canada'],
    ['CD', '刚果（金）', 'DR Congo'],
    ['CF', '中非', 'Central African Republic'],
    ['CG', '刚果（布）', 'Congo'],
    ['CH', '瑞士', 'Switzerland'],
    ['CI', '科特迪瓦', "Côte d'Ivoire"],
    ['CK', '库克群岛', 'Cook Islands'],
    ['CL', '智利', 'Chile'],
    ['CM', '喀麦隆', 'Cameroon'],
    ['CN', '中国', 'China'],
    ['CO', '哥伦比亚', 'Colombia'],
    ['CR', '哥斯达黎加', 'Costa Rica'],
    ['CU', '古巴', 'Cuba'],
    ['CV', '佛得角', 'Cape Verde'],
    ['CW', '库拉索', 'Curaçao'],
    ['CY', '塞浦路斯', 'Cyprus'],
    ['CZ', '捷克', 'Czechia'],
    ['DE', '德国', 'Germany'],
    ['DJ', '吉布提', 'Djibouti'],
    ['DK', '丹麦', 'Denmark'],
    ['DM', '多米尼克', 'Dominica'],
    ['DO', '多米尼加', 'Dominican Republic'],
    ['DZ', '阿尔及利亚', 'Algeria'],
    ['EC', '厄瓜多尔', 'Ecuador'],
    ['EE', '爱沙尼亚', 'Estonia'],
    ['EG', '埃及', 'Egypt'],
    ['ER', '厄立特里亚', 'Eritrea'],
    ['ES', '西班牙', 'Spain'],
    ['ET', '埃塞俄比亚', 'Ethiopia'],
    ['FI', '芬兰', 'Finland'],
    ['FJ', '斐济', 'Fiji'],
    ['FK', '福克兰群岛', 'Falkland Islands'],
    ['FM', '密克罗尼西亚', 'Micronesia'],
    ['FO', '法罗群岛', 'Faroe Islands'],
    ['FR', '法国', 'France'],
    ['GA', '加蓬', 'Gabon'],
    ['GB', '英国', 'United Kingdom'],
    ['GD', '格林纳达', 'Grenada'],
    ['GE', '格鲁吉亚', 'Georgia'],
    ['GF', '法属圭亚那', 'French Guiana'],
    ['GG', '根西', 'Guernsey'],
    ['GH', '加纳', 'Ghana'],
    ['GI', '直布罗陀', 'Gibraltar'],
    ['GL', '格陵兰', 'Greenland'],
    ['GM', '冈比亚', 'Gambia'],
    ['GN', '几内亚', 'Guinea'],
    ['GP', '瓜德罗普', 'Guadeloupe'],
    ['GQ', '赤道几内亚', 'Equatorial Guinea'],
    ['GR', '希腊', 'Greece'],
    ['GT', '危地马拉', 'Guatemala'],
    ['GU', '关岛', 'Guam'],
    ['GW', '几内亚比绍', 'Guinea-Bissau'],
    ['GY', '圭亚那', 'Guyana'],
    ['HK', '中国香港', 'Hong Kong'],
    ['HN', '洪都拉斯', 'Honduras'],
    ['HR', '克罗地亚', 'Croatia'],
    ['HT', '海地', 'Haiti'],
    ['HU', '匈牙利', 'Hungary'],
    ['ID', '印度尼西亚', 'Indonesia'],
    ['IE', '爱尔兰', 'Ireland'],
    ['IL', '以色列', 'Israel'],
    ['IM', '马恩岛', 'Isle of Man'],
    ['IN', '印度', 'India'],
    ['IQ', '伊拉克', 'Iraq'],
    ['IR', '伊朗', 'Iran'],
    ['IS', '冰岛', 'Iceland'],
    ['IT', '意大利', 'Italy'],
    ['JE', '泽西', 'Jersey'],
    ['JM', '牙买加', 'Jamaica'],
    ['JO', '约旦', 'Jordan'],
    ['JP', '日本', 'Japan'],
    ['KE', '肯尼亚', 'Kenya'],
    ['KG', '吉尔吉斯斯坦', 'Kyrgyzstan'],
    ['KH', '柬埔寨', 'Cambodia'],
    ['KI', '基里巴斯', 'Kiribati'],
    ['KM', '科摩罗', 'Comoros'],
    ['KN', '圣基茨和尼维斯', 'Saint Kitts and Nevis'],
    ['KP', '朝鲜', 'North Korea'],
    ['KR', '韩国', 'South Korea'],
    ['KW', '科威特', 'Kuwait'],
    ['KY', '开曼群岛', 'Cayman Islands'],
    ['KZ', '哈萨克斯坦', 'Kazakhstan'],
    ['LA', '老挝', 'Laos'],
    ['LB', '黎巴嫩', 'Lebanon'],
    ['LC', '圣卢西亚', 'Saint Lucia'],
    ['LI', '列支敦士登', 'Liechtenstein'],
    ['LK', '斯里兰卡', 'Sri Lanka'],
    ['LR', '利比里亚', 'Liberia'],
    ['LS', '莱索托', 'Lesotho'],
    ['LT', '立陶宛', 'Lithuania'],
    ['LU', '卢森堡', 'Luxembourg'],
    ['LV', '拉脱维亚', 'Latvia'],
    ['LY', '利比亚', 'Libya'],
    ['MA', '摩洛哥', 'Morocco'],
    ['MC', '摩纳哥', 'Monaco'],
    ['MD', '摩尔多瓦', 'Moldova'],
    ['ME', '黑山', 'Montenegro'],
    ['MG', '马达加斯加', 'Madagascar'],
    ['MH', '马绍尔群岛', 'Marshall Islands'],
    ['MK', '北马其顿', 'North Macedonia'],
    ['ML', '马里', 'Mali'],
    ['MM', '缅甸', 'Myanmar'],
    ['MN', '蒙古', 'Mongolia'],
    ['MO', '中国澳门', 'Macao'],
    ['MP', '北马里亚纳群岛', 'Northern Mariana Islands'],
    ['MQ', '马提尼克', 'Martinique'],
    ['MR', '毛里塔尼亚', 'Mauritania'],
    ['MS', '蒙特塞拉特', 'Montserrat'],
    ['MT', '马耳他', 'Malta'],
    ['MU', '毛里求斯', 'Mauritius'],
    ['MV', '马尔代夫', 'Maldives'],
    ['MW', '马拉维', 'Malawi'],
    ['MX', '墨西哥', 'Mexico'],
    ['MY', '马来西亚', 'Malaysia'],
    ['MZ', '莫桑比克', 'Mozambique'],
    ['NA', '纳米比亚', 'Namibia'],
    ['NC', '新喀里多尼亚', 'New Caledonia'],
    ['NE', '尼日尔', 'Niger'],
    ['NF', '诺福克岛', 'Norfolk Island'],
    ['NG', '尼日利亚', 'Nigeria'],
    ['NI', '尼加拉瓜', 'Nicaragua'],
    ['NL', '荷兰', 'Netherlands'],
    ['NO', '挪威', 'Norway'],
    ['NP', '尼泊尔', 'Nepal'],
    ['NR', '瑙鲁', 'Nauru'],
    ['NU', '纽埃', 'Niue'],
    ['NZ', '新西兰', 'New Zealand'],
    ['OM', '阿曼', 'Oman'],
    ['PA', '巴拿马', 'Panama'],
    ['PE', '秘鲁', 'Peru'],
    ['PF', '法属波利尼西亚', 'French Polynesia'],
    ['PG', '巴布亚新几内亚', 'Papua New Guinea'],
    ['PH', '菲律宾', 'Philippines'],
    ['PK', '巴基斯坦', 'Pakistan'],
    ['PL', '波兰', 'Poland'],
    ['PM', '圣皮埃尔和密克隆', 'Saint Pierre and Miquelon'],
    ['PR', '波多黎各', 'Puerto Rico'],
    ['PS', '巴勒斯坦', 'Palestine'],
    ['PT', '葡萄牙', 'Portugal'],
    ['PW', '帕劳', 'Palau'],
    ['PY', '巴拉圭', 'Paraguay'],
    ['QA', '卡塔尔', 'Qatar'],
    ['RE', '留尼汪', 'Réunion'],
    ['RO', '罗马尼亚', 'Romania'],
    ['RS', '塞尔维亚', 'Serbia'],
    ['RU', '俄罗斯', 'Russia'],
    ['RW', '卢旺达', 'Rwanda'],
    ['SA', '沙特阿拉伯', 'Saudi Arabia'],
    ['SB', '所罗门群岛', 'Solomon Islands'],
    ['SC', '塞舌尔', 'Seychelles'],
    ['SD', '苏丹', 'Sudan'],
    ['SE', '瑞典', 'Sweden'],
    ['SG', '新加坡', 'Singapore'],
    ['SH', '圣赫勒拿', 'Saint Helena'],
    ['SI', '斯洛文尼亚', 'Slovenia'],
    ['SK', '斯洛伐克', 'Slovakia'],
    ['SL', '塞拉利昂', 'Sierra Leone'],
    ['SM', '圣马力诺', 'San Marino'],
    ['SN', '塞内加尔', 'Senegal'],
    ['SO', '索马里', 'Somalia'],
    ['SR', '苏里南', 'Suriname'],
    ['SS', '南苏丹', 'South Sudan'],
    ['ST', '圣多美和普林西比', 'Sao Tome and Principe'],
    ['SV', '萨尔瓦多', 'El Salvador'],
    ['SX', '荷属圣马丁', 'Sint Maarten'],
    ['SY', '叙利亚', 'Syria'],
    ['SZ', '斯威士兰', 'Eswatini'],
    ['TC', '特克斯和凯科斯群岛', 'Turks and Caicos Islands'],
    ['TD', '乍得', 'Chad'],
    ['TG', '多哥', 'Togo'],
    ['TH', '泰国', 'Thailand'],
    ['TJ', '塔吉克斯坦', 'Tajikistan'],
    ['TK', '托克劳', 'Tokelau'],
    ['TL', '东帝汶', 'Timor-Leste'],
    ['TM', '土库曼斯坦', 'Turkmenistan'],
    ['TN', '突尼斯', 'Tunisia'],
    ['TO', '汤加', 'Tonga'],
    ['TR', '土耳其', 'Turkey'],
    ['TT', '特立尼达和多巴哥', 'Trinidad and Tobago'],
    ['TV', '图瓦卢', 'Tuvalu'],
    ['TW', '中国台湾', 'Taiwan'],
    ['TZ', '坦桑尼亚', 'Tanzania'],
    ['UA', '乌克兰', 'Ukraine'],
    ['UG', '乌干达', 'Uganda'],
    ['US', '美国', 'United States'],
    ['UY', '乌拉圭', 'Uruguay'],
    ['UZ', '乌兹别克斯坦', 'Uzbekistan'],
    ['VA', '梵蒂冈', 'Vatican City'],
    ['VC', '圣文森特和格林纳丁斯', 'Saint Vincent and the Grenadines'],
    ['VE', '委内瑞拉', 'Venezuela'],
    ['VG', '英属维尔京群岛', 'British Virgin Islands'],
    ['VI', '美属维尔京群岛', 'U.S. Virgin Islands'],
    ['VN', '越南', 'Vietnam'],
    ['VU', '瓦努阿图', 'Vanuatu'],
    ['WF', '瓦利斯和富图纳', 'Wallis and Futuna'],
    ['WS', '萨摩亚', 'Samoa'],
    ['YE', '也门', 'Yemen'],
    ['YT', '马约特', 'Mayotte'],
    ['ZA', '南非', 'South Africa'],
    ['ZM', '赞比亚', 'Zambia'],
    ['ZW', '津巴布韦', 'Zimbabwe'],
  ];

  const COUNTRIES = RAW.map(([code, zh, en]) => ({ code, zh, en }));

  /** 代码 → 记录（大小写不敏感，统一按大写建索引） */
  const BY_CODE = {};
  COUNTRIES.forEach(c => { BY_CODE[c.code] = c; });

  const CountryData = {

    /** 全部国家 / 地区（按二字代码升序，即 RAW 的书写顺序） */
    all() {
      return COUNTRIES.slice();
    },

    count() {
      return COUNTRIES.length;
    },

    /** 按二字代码取（'us' / ' US ' 都能取到），取不到返回 null */
    findByCode(code) {
      const k = String(code == null ? '' : code).trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(k)) return null;
      return BY_CODE[k] || null;
    },

    /** 中文名精确匹配（去空格），取不到返回 null */
    findByZh(zh) {
      const k = String(zh == null ? '' : zh).trim();
      if (!k) return null;
      return COUNTRIES.find(c => c.zh === k) || null;
    },

    /** 英文名精确匹配（忽略大小写与首尾空格），取不到返回 null */
    findByEn(en) {
      const k = String(en == null ? '' : en).trim().toLowerCase();
      if (!k) return null;
      return COUNTRIES.find(c => c.en.toLowerCase() === k) || null;
    },

    /**
     * 模糊检索：中文名 / 英文名 / 二字代码任一命中即算匹配。
     * 中文按子串命中；英文额外支持「词首缩写」以外的普通子串（如 'united'）。
     * @param {string} term 关键词
     * @param {number} [limit] 最多返回条数（默认 30）
     */
    search(term, limit) {
      const t = String(term == null ? '' : term).trim().toLowerCase();
      const max = Number.isFinite(limit) && limit > 0 ? limit : 30;
      if (!t) return COUNTRIES.slice(0, max);
      const exact = [];
      const starts = [];
      const contains = [];
      COUNTRIES.forEach(c => {
        const code = c.code.toLowerCase();
        const zh = c.zh.toLowerCase();
        const en = c.en.toLowerCase();
        if (code === t || zh === t || en === t) { exact.push(c); return; }
        if (zh.startsWith(t) || en.startsWith(t) || code.startsWith(t)) { starts.push(c); return; }
        if (zh.includes(t) || en.includes(t) || code.includes(t)) contains.push(c);
      });
      return exact.concat(starts, contains).slice(0, max);
    },
  };

  // 数据自检：二字代码重复 / 位数不对会让「选了候选却补错国家」，这里直接报出来
  (function sanityCheck() {
    const seen = {};
    COUNTRIES.forEach(c => {
      if (!/^[A-Z]{2}$/.test(c.code)) console.warn('[CountryData] 二字代码不合法:', c);
      if (seen[c.code]) console.warn('[CountryData] 二字代码重复:', c.code);
      seen[c.code] = true;
    });
  })();

  if (typeof window !== 'undefined') window.CountryData = CountryData;

})();
