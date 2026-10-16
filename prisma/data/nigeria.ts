/** Nigerian states (ISO 3166-2:NG codes) and the FCT. */
export const STATES: { name: string; code: string }[] = [
  { name: 'Abia', code: 'AB' }, { name: 'Adamawa', code: 'AD' }, { name: 'Akwa Ibom', code: 'AK' }, { name: 'Anambra', code: 'AN' },
  { name: 'Bauchi', code: 'BA' }, { name: 'Bayelsa', code: 'BY' }, { name: 'Benue', code: 'BE' }, { name: 'Borno', code: 'BO' },
  { name: 'Cross River', code: 'CR' }, { name: 'Delta', code: 'DE' }, { name: 'Ebonyi', code: 'EB' }, { name: 'Edo', code: 'ED' },
  { name: 'Ekiti', code: 'EK' }, { name: 'Enugu', code: 'EN' }, { name: 'Federal Capital Territory', code: 'FC' }, { name: 'Gombe', code: 'GO' },
  { name: 'Imo', code: 'IM' }, { name: 'Jigawa', code: 'JI' }, { name: 'Kaduna', code: 'KD' }, { name: 'Kano', code: 'KN' },
  { name: 'Katsina', code: 'KT' }, { name: 'Kebbi', code: 'KE' }, { name: 'Kogi', code: 'KO' }, { name: 'Kwara', code: 'KW' },
  { name: 'Lagos', code: 'LA' }, { name: 'Nasarawa', code: 'NA' }, { name: 'Niger', code: 'NI' }, { name: 'Ogun', code: 'OG' },
  { name: 'Ondo', code: 'ON' }, { name: 'Osun', code: 'OS' }, { name: 'Oyo', code: 'OY' }, { name: 'Plateau', code: 'PL' },
  { name: 'Rivers', code: 'RI' }, { name: 'Sokoto', code: 'SO' }, { name: 'Taraba', code: 'TA' }, { name: 'Yobe', code: 'YO' },
  { name: 'Zamfara', code: 'ZA' },
];

/**
 * LGAs keyed by state code. Complete lists are included for the launch states below; add the
 * remaining states here (same shape) before go-live — the seed is idempotent and can be re-run.
 */
export const LGAS: Record<string, string[]> = {
  FC: ['Abaji', 'Bwari', 'Gwagwalada', 'Kuje', 'Kwali', 'Municipal Area Council'],
  LA: ['Agege', 'Ajeromi-Ifelodun', 'Alimosho', 'Amuwo-Odofin', 'Apapa', 'Badagry', 'Epe', 'Eti-Osa', 'Ibeju-Lekki', 'Ifako-Ijaiye', 'Ikeja', 'Ikorodu', 'Kosofe', 'Lagos Island', 'Lagos Mainland', 'Mushin', 'Ojo', 'Oshodi-Isolo', 'Shomolu', 'Surulere'],
  KD: ['Birnin Gwari', 'Chikun', 'Giwa', 'Igabi', 'Ikara', 'Jaba', "Jema'a", 'Kachia', 'Kaduna North', 'Kaduna South', 'Kagarko', 'Kajuru', 'Kaura', 'Kauru', 'Kubau', 'Kudan', 'Lere', 'Makarfi', 'Sabon Gari', 'Sanga', 'Soba', 'Zangon Kataf', 'Zaria'],
  KN: ['Ajingi', 'Albasu', 'Bagwai', 'Bebeji', 'Bichi', 'Bunkure', 'Dala', 'Dambatta', 'Dawakin Kudu', 'Dawakin Tofa', 'Doguwa', 'Fagge', 'Gabasawa', 'Garko', 'Garun Mallam', 'Gaya', 'Gezawa', 'Gwale', 'Gwarzo', 'Kabo', 'Kano Municipal', 'Karaye', 'Kibiya', 'Kiru', 'Kumbotso', 'Kunchi', 'Kura', 'Madobi', 'Makoda', 'Minjibir', 'Nasarawa', 'Rano', 'Rimin Gado', 'Rogo', 'Shanono', 'Sumaila', 'Takai', 'Tarauni', 'Tofa', 'Tsanyawa', 'Tudun Wada', 'Ungogo', 'Warawa', 'Wudil'],
  KE: ['Aleiro', 'Arewa Dandi', 'Argungu', 'Augie', 'Bagudo', 'Birnin Kebbi', 'Bunza', 'Dandi', 'Fakai', 'Gwandu', 'Jega', 'Kalgo', 'Koko/Besse', 'Maiyama', 'Ngaski', 'Sakaba', 'Shanga', 'Suru', 'Wasagu/Danko', 'Yauri', 'Zuru'],
  BE: ['Ado', 'Agatu', 'Apa', 'Buruku', 'Gboko', 'Guma', 'Gwer East', 'Gwer West', 'Katsina-Ala', 'Konshisha', 'Kwande', 'Logo', 'Makurdi', 'Obi', 'Ogbadibo', 'Ohimini', 'Oju', 'Okpokwu', 'Otukpo', 'Tarka', 'Ukum', 'Ushongo', 'Vandeikya'],
  NI: ['Agaie', 'Agwara', 'Bida', 'Borgu', 'Bosso', 'Chanchaga', 'Edati', 'Gbako', 'Gurara', 'Katcha', 'Kontagora', 'Lapai', 'Lavun', 'Magama', 'Mariga', 'Mashegu', 'Mokwa', 'Munya', 'Paikoro', 'Rafi', 'Rijau', 'Shiroro', 'Suleja', 'Tafa', 'Wushishi'],
  PL: ['Barkin Ladi', 'Bassa', 'Bokkos', 'Jos East', 'Jos North', 'Jos South', 'Kanam', 'Kanke', 'Langtang North', 'Langtang South', 'Mangu', 'Mikang', 'Pankshin', "Qua'an Pan", 'Riyom', 'Shendam', 'Wase'],
  OG: ['Abeokuta North', 'Abeokuta South', 'Ado-Odo/Ota', 'Ewekoro', 'Ifo', 'Ijebu East', 'Ijebu North', 'Ijebu North East', 'Ijebu Ode', 'Ikenne', 'Imeko Afon', 'Ipokia', 'Obafemi Owode', 'Odeda', 'Odogbolu', 'Ogun Waterside', 'Remo North', 'Sagamu', 'Yewa North', 'Yewa South'],
};

/** Sample cities/towns keyed by `${stateCode}|${lgaName}`. */
export const CITIES: Record<string, string[]> = {
  'FC|Municipal Area Council': ['Asokoro', 'Garki', 'Maitama', 'Wuse', 'Lugbe', 'Karu'],
  'FC|Gwagwalada': ['Gwagwalada', 'Dobi', 'Paikon Kore'],
  'FC|Bwari': ['Bwari', 'Kubwa', 'Dutse'],
  'LA|Ikeja': ['Ikeja', 'Ojodu', 'Opebi'],
  'LA|Epe': ['Epe', 'Ejinrin', 'Agbowa'],
  'KD|Zaria': ['Zaria', 'Tudun Wada'],
  'KN|Kano Municipal': ['Kano', 'Kofar Mata'],
  'KE|Argungu': ['Argungu', 'Lailaba'],
  'BE|Makurdi': ['Makurdi', 'North Bank'],
  'NI|Bida': ['Bida', 'Doko'],
  'PL|Jos North': ['Jos', 'Angwan Rogo'],
};

/** Nigerian banks with CBN/NIBSS institution codes. */
export const BANKS: { name: string; code: string }[] = [
  { name: 'Access Bank', code: '044' },
  { name: 'Citibank Nigeria', code: '023' },
  { name: 'Ecobank Nigeria', code: '050' },
  { name: 'Fidelity Bank', code: '070' },
  { name: 'First Bank of Nigeria', code: '011' },
  { name: 'First City Monument Bank', code: '214' },
  { name: 'Globus Bank', code: '00103' },
  { name: 'Guaranty Trust Bank', code: '058' },
  { name: 'Jaiz Bank', code: '301' },
  { name: 'Keystone Bank', code: '082' },
  { name: 'Kuda Microfinance Bank', code: '50211' },
  { name: 'Moniepoint Microfinance Bank', code: '50515' },
  { name: 'OPay', code: '999992' },
  { name: 'PalmPay', code: '999991' },
  { name: 'Parallex Bank', code: '104' },
  { name: 'Polaris Bank', code: '076' },
  { name: 'Providus Bank', code: '101' },
  { name: 'Stanbic IBTC Bank', code: '221' },
  { name: 'Standard Chartered Bank', code: '068' },
  { name: 'Sterling Bank', code: '232' },
  { name: 'SunTrust Bank', code: '100' },
  { name: 'Titan Trust Bank', code: '102' },
  { name: 'Union Bank of Nigeria', code: '032' },
  { name: 'United Bank for Africa', code: '033' },
  { name: 'Unity Bank', code: '215' },
  { name: 'Wema Bank', code: '035' },
  { name: 'Zenith Bank', code: '057' },
];
