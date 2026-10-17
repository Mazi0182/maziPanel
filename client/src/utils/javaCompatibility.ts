import type React from 'react';
import { CheckCircle2, Download } from 'lucide-react';

/**
 * Java and Minecraft Core/Version Compatibility Helper
 *
 * Rules verified from Paper docs (https://docs.papermc.io/paper/getting-started/):
 * - Paper/Purpur:
 *   1.7.10 - 1.11: Java 8
 *   1.12 - 1.16.4: Java 11 (min 8)
 *   1.16.5: Java 16 (min 16)
 *   1.17 - 1.19: Java 17 (min 17)
 *   1.20 - 1.20.4: Java 21 (min 17)
 *   1.20.5 - 1.21.11: Java 21 (min 21)
 *   26.1+: Java 25 (min 25)
 *
 * - Vanilla:
 *   Mojang version metadata javaVersion.majorVersion when available:
 *   1.17: 16
 *   1.18 - 1.20.4: 17
 *   1.20.5+: 21
 *   26.x: 25
 *   Older (<= 1.16.5): 8
 */

export interface JavaRequirement {
  minJava: number | null;
  recommendedJava: number | null;
  compatibleMajors: number[];
  captionTr: string;
  isUnknown: boolean;
}

/**
 * Strict semantic release version parser.
 * Requires full semantic release pattern like "1.20.4", "1.12", "26.1".
 * Rejects snapshots and prefix strings (e.g. "26w14a", "26.4-snapshot-3") returning null.
 */
export function parseVersionNumbers(verStr?: string | null): { major: number; minor: number; patch: number; raw: string } | null {
  if (!verStr || typeof verStr !== 'string') return null;
  const cleaned = verStr.trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3] || '0', 10),
    raw: cleaned
  };
}

export function getJavaRequirements(
  coreType?: string | null,
  mcVersion?: string | null,
  mojangMetadata?: any | null
): JavaRequirement {
  const cleanCore = (coreType || 'paper').toLowerCase().trim();

  // If Vanilla has official Mojang version metadata with javaVersion.majorVersion, honor it directly
  if (cleanCore === 'vanilla' && mojangMetadata) {
    const rawMajor = mojangMetadata.majorVersion || mojangMetadata.javaVersion?.majorVersion;
    const reqMajor = parseInt(rawMajor, 10);
    if (!isNaN(reqMajor) && reqMajor >= 8) {
      let compatibleMajors = [reqMajor];
      if (reqMajor === 16) {
        compatibleMajors = [16, 17];
      }
      return {
        minJava: reqMajor,
        recommendedJava: reqMajor,
        compatibleMajors,
        captionTr: `Önerilen: Java ${reqMajor} (Gereken: Java ${reqMajor})`,
        isUnknown: false
      };
    }
  }

  const parsed = parseVersionNumbers(mcVersion);

  // If unknown version or snapshot without parseable numbers or Mojang metadata
  if (!parsed) {
    return {
      minJava: null,
      recommendedJava: null,
      compatibleMajors: [],
      captionTr: 'Bilinmeyen sürüm / snapshot · Seçim kullanıcıya bırakıldı',
      isUnknown: true
    };
  }

  const { major, minor, patch } = parsed;

  // 1. Vanilla engine
  if (cleanCore === 'vanilla') {
    if (major >= 26) {
      return {
        minJava: 25,
        recommendedJava: 25,
        compatibleMajors: [25, 27],
        captionTr: 'Önerilen: Java 25 (En Düşük: Java 25)',
        isUnknown: false
      };
    }

    if (major === 1) {
      if (minor > 20 || (minor === 20 && patch >= 5)) {
        return {
          minJava: 21,
          recommendedJava: 21,
          compatibleMajors: [21],
          captionTr: 'Önerilen: Java 21 (Gereken: Java 21)',
          isUnknown: false
        };
      }
      if ((minor === 20 && patch < 5) || minor === 19 || minor === 18) {
        return {
          minJava: 17,
          recommendedJava: 17,
          compatibleMajors: [17],
          captionTr: 'Önerilen: Java 17 (Gereken: Java 17)',
          isUnknown: false
        };
      }
      if (minor === 17) {
        return {
          minJava: 16,
          recommendedJava: 16,
          compatibleMajors: [16, 17],
          captionTr: 'Önerilen: Java 16 (Gereken: Java 16)',
          isUnknown: false
        };
      }
      // 1.16.5 and older Vanilla runs on Java 8
      return {
        minJava: 8,
        recommendedJava: 8,
        compatibleMajors: [8],
        captionTr: 'Önerilen: Java 8 (Gereken: Java 8)',
        isUnknown: false
      };
    }
  }

  // 2. Paper & Purpur (and standard forks)
  // 26.1+ -> Java 25 minimum (Java 25, 27 modern choices valid, recommend 25)
  if (major >= 26) {
    return {
      minJava: 25,
      recommendedJava: 25,
      compatibleMajors: [25, 27],
      captionTr: 'Önerilen: Java 25 (En Düşük: Java 25)',
      isUnknown: false
    };
  }

  if (major === 1) {
    // 1.20 - 1.21.11 -> Java 21
    if (minor >= 20) {
      const isEarly120 = minor === 20 && patch < 5;
      const minJ = isEarly120 ? 17 : 21;
      return {
        minJava: minJ,
        recommendedJava: 21,
        compatibleMajors: isEarly120 ? [21, 17] : [21],
        captionTr: isEarly120
          ? 'Önerilen: Java 21 (En Düşük: Java 17)'
          : 'Önerilen: Java 21 (Gereken: Java 21)',
        isUnknown: false
      };
    }

    // 1.17 - 1.19 -> Java 17
    if (minor >= 17 && minor <= 19) {
      return {
        minJava: 17,
        recommendedJava: 17,
        compatibleMajors: [17],
        captionTr: 'Önerilen: Java 17 (Gereken: Java 17)',
        isUnknown: false
      };
    }

    // 1.16.5 -> Java 16
    if (minor === 16 && patch >= 5) {
      return {
        minJava: 16,
        recommendedJava: 16,
        compatibleMajors: [16, 17],
        captionTr: 'Önerilen: Java 16 (Gereken: Java 16)',
        isUnknown: false
      };
    }

    // 1.12 - 1.16.4 -> Java 11
    if (minor >= 12 && minor <= 16) {
      return {
        minJava: 11,
        recommendedJava: 11,
        compatibleMajors: [11],
        captionTr: 'Önerilen: Java 11 (Gereken: Java 11)',
        isUnknown: false
      };
    }

    // 1.7.10 - 1.11 -> Java 8
    if (minor <= 11) {
      return {
        minJava: 8,
        recommendedJava: 8,
        compatibleMajors: [8],
        captionTr: 'Önerilen: Java 8 (Gereken: Java 8)',
        isUnknown: false
      };
    }
  }

  // Fallback for unexpected version patterns: do not guess incompatible
  return {
    minJava: null,
    recommendedJava: null,
    compatibleMajors: [],
    captionTr: 'Bilinmeyen sürüm · Seçim kullanıcıya bırakıldı',
    isUnknown: true
  };
}

export interface JavaCompatibilityInfo {
  isCompatible: boolean;
  isRecommended: boolean;
  badgeText: string;
  badgeVariant: 'success' | 'warning' | 'danger' | 'neutral';
  reasonTr?: string;
}

export function getJavaCompatibilityInfo(
  javaMajor: number | null | undefined,
  req: JavaRequirement
): JavaCompatibilityInfo {
  if (!javaMajor || javaMajor <= 0) {
    return {
      isCompatible: true,
      isRecommended: false,
      badgeText: 'Otomatik',
      badgeVariant: 'neutral'
    };
  }

  if (req.isUnknown || !req.minJava) {
    return {
      isCompatible: true,
      isRecommended: false,
      badgeText: 'Belirsiz',
      badgeVariant: 'neutral'
    };
  }

  // 1. Resmi önerilen sürüm ile tam eşleşme
  if (req.recommendedJava && javaMajor === req.recommendedJava) {
    return {
      isCompatible: true,
      isRecommended: true,
      badgeText: 'Önerilen',
      badgeVariant: 'success',
      reasonTr: `Minecraft sürümünüz için resmi önerilen Java sürümü (Java ${req.recommendedJava}).`
    };
  }

  // 2. Modern 25+ sürümler (26.x ve üstü için)
  if (req.minJava >= 25 && javaMajor >= 25) {
    return {
      isCompatible: true,
      isRecommended: false,
      badgeText: 'Uyumlu',
      badgeVariant: 'success',
      reasonTr: `Java ${javaMajor}, bu sürümle uyumludur.`
    };
  }

  // 3. Uyumlu liste kontrolü
  if (req.compatibleMajors.includes(javaMajor)) {
    return {
      isCompatible: true,
      isRecommended: false,
      badgeText: 'Uyumlu',
      badgeVariant: 'success',
      reasonTr: `Java ${javaMajor}, bu sürümle uyumludur.`
    };
  }

  // 4. Asgari gereksinimin altında
  if (javaMajor < req.minJava) {
    return {
      isCompatible: false,
      isRecommended: false,
      badgeText: `En az Java ${req.minJava} gerekli`,
      badgeVariant: 'danger',
      reasonTr: `Bu sunucu için en az Java ${req.minJava} gereklidir. Seçilen Java ${javaMajor} yetersiz kalacaktır.`
    };
  }

  // 5. Uyumsuz / eski sürüm için fazla yeni
  return {
    isCompatible: false,
    isRecommended: false,
    badgeText: 'Eski sürümle uyumsuz olabilir',
    badgeVariant: 'warning',
    reasonTr: `Java ${javaMajor}, bu Minecraft sürümü için fazla yeni olabilir. Önerilen: Java ${req.recommendedJava || req.minJava}.`
  };
}

export function isJavaCompatible(
  javaMajor?: number | null,
  coreType?: string | null,
  mcVersion?: string | null,
  mojangMetadata?: any | null,
  isExplicitCustomPath: boolean = false
): boolean {
  if (!javaMajor) return true; // auto/unknown
  const req = getJavaRequirements(coreType, mcVersion, mojangMetadata);
  if (req.isUnknown || !req.minJava) return true;
  if (isExplicitCustomPath) {
    return javaMajor >= req.minJava;
  }
  // Modern 26 requires 25 minimum: modern installed/Oracle (25+) remain valid choices
  if (req.minJava >= 25) {
    return javaMajor >= 25;
  }
  return req.compatibleMajors.includes(javaMajor);
}

export interface JavaSelectOption {
  value: string;
  label: string;
  desc?: string;
  badge?: {
    text: string;
    variant?: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  };
  icon?: React.ComponentType<{ className?: string }>;
  statusIcon?: React.ComponentType<{ className?: string }>;
  statusTitle?: string;
  statusIconClassName?: string;
  disabled?: boolean;
  lineThrough?: boolean;
  majorVersion?: number | null;
  installed?: boolean;
  installedPath?: string | null;
  isInvalid?: boolean;
  isCompatible?: boolean;
  isRecommended?: boolean;
}

export interface BuildJavaSelectOptionsParams {
  installedJavas: Array<{
    path: string;
    majorVersion?: number | null;
    rawVersion?: string;
    vendor?: string;
  }>;
  catalogJavas: Array<{
    majorVersion: number;
    name?: string;
    vendor?: string;
  }>;
  javaReq: JavaRequirement;
  includeAuto?: boolean;
  customJavaPath?: string | null;
}

export function buildJavaSelectOptions(params: BuildJavaSelectOptionsParams): JavaSelectOption[] {
  const {
    installedJavas = [],
    catalogJavas = [],
    javaReq,
    includeAuto = false,
    customJavaPath,
  } = params;

  const seenPaths = new Set<string>();
  const seenMajors = new Set<number>();
  const detectedOpts: JavaSelectOption[] = [];

  // 1. Kurulu Java kurulumları
  for (const j of installedJavas) {
    if (!j.path || seenPaths.has(j.path)) continue;
    seenPaths.add(j.path);
    const major = Number(j.majorVersion) || 0;
    if (major > 0) seenMajors.add(major);
    const isInvalid = major < 25;
    const info = getJavaCompatibilityInfo(major, javaReq);
    const isEffectiveCompatible = !isInvalid && (major >= 25 || info.isCompatible);
    const isEffectiveRecommended =
      !isInvalid &&
      (info.isRecommended || (Boolean(javaReq.recommendedJava && javaReq.recommendedJava < 25) && major === 25));

    let badgeText = 'Uyumlu';
    let badgeVariant: 'success' | 'warning' | 'danger' = 'success';
    if (isInvalid || !isEffectiveCompatible) {
      badgeText = 'Uyumsuz';
      badgeVariant = 'danger';
    } else if (isEffectiveRecommended) {
      badgeText = 'Önerilen';
      badgeVariant = 'success';
    }

    detectedOpts.push({
      value: j.path,
      label: `Java ${major || j.rawVersion || ''}`,
      statusIcon: CheckCircle2,
      statusTitle: isInvalid
        ? 'Kurulu (Geçersiz: Java 25 altı sürümler desteklenmez)'
        : 'Kurulu',
      statusIconClassName: isInvalid
        ? 'w-3.5 h-3.5 text-silver-500 shrink-0'
        : 'w-3.5 h-3.5 text-emerald-400 shrink-0',
      badge: {
        text: badgeText,
        variant: badgeVariant,
      },
      disabled: isInvalid,
      lineThrough: isInvalid,
      majorVersion: major,
      installed: true,
      installedPath: j.path,
      isInvalid,
      isCompatible: isEffectiveCompatible,
      isRecommended: isEffectiveRecommended,
    });
  }

  // 2. Henüz kurulmamış katalog Java sürümleri
  for (const c of catalogJavas) {
    const major = Number(c.majorVersion) || 0;
    if (seenMajors.has(major)) continue;
    seenMajors.add(major);

    const isInvalid = major < 25;
    const info = getJavaCompatibilityInfo(major, javaReq);
    const isEffectiveCompatible = !isInvalid && (major >= 25 || info.isCompatible);
    const isEffectiveRecommended =
      !isInvalid &&
      (info.isRecommended || (Boolean(javaReq.recommendedJava && javaReq.recommendedJava < 25) && major === 25));

    let badgeText = 'Uyumlu';
    let badgeVariant: 'success' | 'warning' | 'danger' = 'success';
    if (isInvalid || !isEffectiveCompatible) {
      badgeText = 'Uyumsuz';
      badgeVariant = 'danger';
    } else if (isEffectiveRecommended) {
      badgeText = 'Önerilen';
      badgeVariant = 'success';
    }

    detectedOpts.push({
      value: `install-${major}`,
      label: `Java ${major}`,
      statusIcon: Download,
      statusTitle: isInvalid
        ? 'İndirilebilir (Geçersiz: Java 25 altı sürümler desteklenmez)'
        : 'İndirilebilir',
      statusIconClassName: isInvalid
        ? 'w-3.5 h-3.5 text-silver-500 shrink-0'
        : 'w-3.5 h-3.5 text-sky-400 shrink-0',
      badge: {
        text: badgeText,
        variant: badgeVariant,
      },
      disabled: isInvalid,
      lineThrough: isInvalid,
      majorVersion: major,
      installed: false,
      installedPath: null,
      isInvalid,
      isCompatible: isEffectiveCompatible,
      isRecommended: isEffectiveRecommended,
    });
  }

  // Sayısal azalan sıra (en yeni üstte, örn: Java 27 -> Java 25 -> Java 21)
  detectedOpts.sort((a, b) => (b.majorVersion || 0) - (a.majorVersion || 0));

  const result: JavaSelectOption[] = [];

  // 3. Otomatik seçeneği (yalnızca includeAuto true ise ve sade Türkçe metinle)
  if (includeAuto) {
    result.push({
      value: 'auto',
      label: 'Otomatik',
      desc: 'Sistem sunucu için en uyumlu Java sürümünü seçer',
      badge: {
        text: 'Önerilen',
        variant: 'success',
      },
      majorVersion: 0,
      installed: true,
      isInvalid: false,
      isCompatible: true,
      isRecommended: true,
    });
  }

  result.push(...detectedOpts);

  // 4. Özel Java Yolu (ayarlanmışsa ve algılanan listede yoksa)
  if (
    customJavaPath &&
    customJavaPath !== 'auto' &&
    !detectedOpts.some((j) => j.value === customJavaPath)
  ) {
    result.push({
      value: customJavaPath,
      label: 'Özel Java Yolu',
      badge: {
        text: 'Özel Yol',
        variant: 'info',
      },
      installed: true,
      installedPath: customJavaPath,
      isInvalid: false,
      isCompatible: true,
      isRecommended: false,
    });
  }

  return result;
}

