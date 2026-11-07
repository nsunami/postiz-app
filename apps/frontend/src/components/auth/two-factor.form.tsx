'use client';

import { FC, FormEvent, useCallback, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useT } from '@gitroom/react/translation/get.transation.service.client';

export const TwoFactorForm: FC<{
  challenge: string;
  onCancel: () => void;
}> = ({ challenge, onCancel }) => {
  const t = useT();
  const fetchData = useFetch();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!code.trim()) {
        return;
      }

      setLoading(true);
      setError('');

      const response = await fetchData('/auth/2fa/verify', {
        method: 'POST',
        body: JSON.stringify({ challenge, code: code.trim() }),
      });

      // On success the response carries the `reload` header and the shared
      // fetch wrapper takes over, so only failures are handled here.
      if (response.status === 400 || response.status === 429) {
        setError(await response.text());
        setLoading(false);
      }
    },
    [challenge, code, fetchData]
  );

  return (
    <form className="flex-1 flex" onSubmit={submit}>
      <div className="flex flex-col flex-1">
        <div>
          <h1 className="text-[40px] font-[500] -tracking-[0.8px] text-start">
            {t('two_factor_verification', 'Two-factor verification')}
          </h1>
        </div>
        <div className="text-[14px] mt-[12px] mb-[32px] text-customColor18">
          {t(
            'two_factor_enter_code',
            'Enter the 6-digit code from your authenticator app, or one of your recovery codes.'
          )}
        </div>
        <div className="flex flex-col gap-[12px]">
          <Input
            label={t('two_factor_code', 'Authentication code')}
            name="two-factor-code"
            disableForm={true}
            autoComplete="one-time-code"
            autoFocus={true}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            removeError={true}
          />
          {!!error && <div className="text-red-400 text-[14px]">{error}</div>}
          <div className="w-full flex gap-[12px] mt-[12px]">
            <Button
              type="submit"
              className="flex-1 rounded-[10px] !h-[52px]"
              loading={loading}
            >
              {t('verify', 'Verify')}
            </Button>
          </div>
          <div className="text-center mt-[8px]">
            <button
              type="button"
              className="text-[14px] underline cursor-pointer"
              onClick={onCancel}
            >
              {t('back_to_sign_in', 'Back to sign in')}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
};
