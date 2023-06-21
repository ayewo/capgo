CREATE TABLE
  public.orgs (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    logo text NULL,
    name text NOT NULL,
    customer_id character varying,
    constraint orgs_pkey primary key (id)
  );

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON public.orgs FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');

CREATE TABLE
  public.org_rights (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid NOT NULL,
    org bigint NOT NULL,
    app character varying NULL,
    channel bigint NULL,
    right public.user_right NOT NULL default 'read'::user_right,
    constraint org_user_id_app_channel_pkey primary key (id),
    constraint org_rights_app_fkey foreign key (app) references apps (app_id) on delete cascade,
    constraint org_rights_channel_fkey foreign key (channel) references channels (id) on delete cascade,
    constraint org_rights_org_fkey foreign key (org) references orgs (id) on delete cascade,
    constraint org_rights_user_fkey foreign key ("user") references users (id) on delete cascade
  );

ALTER TABLE public.org_rights ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.org_rights_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON public.org_rights FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');