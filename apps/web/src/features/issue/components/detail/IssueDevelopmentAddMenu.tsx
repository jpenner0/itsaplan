import { GitPullRequest, Link2, Plus, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export default function IssueDevelopmentAddMenu({
  onLink,
  onCreate,
  onPublish,
}: {
  // Link and create need the repository permission; publish needs only the issue edit permission.
  onLink?: () => void;
  onCreate?: () => void;
  // Set only when the issue can be published to the synced GitHub repository.
  onPublish?: () => void;
}) {
  const t = useTranslations('issue.development');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-muted-foreground">
          <Plus className="size-3.5" />
          {t('add')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {onLink && (
          <DropdownMenuItem onSelect={onLink}>
            <Link2 />
            {t('linkExisting')}
          </DropdownMenuItem>
        )}
        {onCreate && (
          <DropdownMenuItem onSelect={onCreate}>
            <GitPullRequest />
            {t('createPullRequest')}
          </DropdownMenuItem>
        )}
        {onPublish && (
          <DropdownMenuItem onSelect={onPublish}>
            <Upload />
            {t('publish')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
