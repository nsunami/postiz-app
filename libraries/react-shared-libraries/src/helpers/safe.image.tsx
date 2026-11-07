'use client';

import { FC } from 'react';
import { ImageProps } from 'next/image';

type SafeImageProps = Omit<ImageProps, 'src'> & {
  src: string;
};

const SafeImage: FC<SafeImageProps> = ({
  src,
  alt,
  width,
  height,
  className,
  style,
  // Most images here are user media rendered in long grids/lists (media
  // library, calendar, previews). Lazy by default to keep them out of the
  // initial render cost; callers can override with eager.
  loading = 'lazy',
  decoding = 'async',
}) => {
  return (
    <img
      src={src}
      alt={alt?.toString() || ''}
      width={typeof width === 'number' ? width : undefined}
      height={typeof height === 'number' ? height : undefined}
      className={className}
      style={style}
      loading={loading}
      decoding={decoding}
    />
  );
};

export default SafeImage;
